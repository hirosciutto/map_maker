#!/usr/bin/env python3

from __future__ import annotations

import argparse
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_geo_biome_world import BIOMES, RGB, image_from_code_array, sanitize_resized_beaches, write_json  # noqa: E402
from generate_fantasy_biome_world import (  # noqa: E402
    SOURCE_IMAGE,
    WATER,
    file_hash,
    lon_lat_grids,
    read_codes,
    read_codes_from_image,
    split_macro_regions,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
STRUCTURE = np.ones((3, 3), dtype=np.uint8)
GAP = 1
MARGIN = 4


def fill_new_cells(codes: np.ndarray, original: np.ndarray, additions: np.ndarray) -> None:
    if not additions.any():
        return
    _, indices = ndimage.distance_transform_edt(~original, return_indices=True)
    codes[additions] = codes[indices[0][additions], indices[1][additions]]


def preserve_codes_and_components(
    source_codes: np.ndarray,
    source_mask: np.ndarray,
    transformed_codes: np.ndarray,
    transformed_mask: np.ndarray,
    mapped_x: np.ndarray,
    mapped_y: np.ndarray,
) -> tuple[int, int]:
    rescued_components = 0
    labels, count = ndimage.label(source_mask, structure=STRUCTURE)
    for label in range(1, count + 1):
        ys, xs = np.where(labels == label)
        if not xs.size:
            continue
        point = len(xs) // 2
        tx = int(mapped_x[ys[point], xs[point]])
        ty = int(mapped_y[ys[point], xs[point]])
        y0, y1 = max(0, ty - 1), min(transformed_mask.shape[0], ty + 2)
        x0, x1 = max(0, tx - 1), min(transformed_mask.shape[1], tx + 2)
        if not transformed_mask[y0:y1, x0:x1].any():
            transformed_mask[ty, tx] = True
            transformed_codes[ty, tx] = source_codes[ys[point], xs[point]]
            rescued_components += 1

    rescued_codes = 0
    for code in np.unique(source_codes[source_mask]):
        if np.any(transformed_mask & (transformed_codes == code)):
            continue
        ys, xs = np.where(source_mask & (source_codes == code))
        point = len(xs) // 2
        tx = int(mapped_x[ys[point], xs[point]])
        ty = int(mapped_y[ys[point], xs[point]])
        transformed_mask[ty, tx] = True
        transformed_codes[ty, tx] = code
        rescued_codes += 1
    return rescued_components, rescued_codes


def transform_region(
    source: np.ndarray,
    mask: np.ndarray,
    lat_grid: np.ndarray,
    scale: float,
    phase: float,
) -> tuple[np.ndarray, np.ndarray, int, int]:
    ys, xs = np.where(mask)
    if not xs.size:
        raise RuntimeError("変形対象の陸塊が空です")
    center_x = float(np.median(xs))
    center_y = float(np.median(ys))
    latitude = lat_grid[ys, xs]
    high = np.clip((latitude - 55) / 30, 0, 1)
    equal_area = np.clip(np.cos(np.radians(latitude)) / math.cos(math.radians(55)), 0.34, 1.0)
    x_factor = 1 - high * (1 - equal_area)
    x_rel = (xs - center_x) * x_factor
    y_rel = ys - center_y
    x_warp = np.sin(y_rel / 31 + phase) * 3.5 + np.sin(y_rel / 13 + phase * 0.7) * 1.4
    y_warp = np.sin(x_rel / 43 + phase) * 2.8 + np.sin(x_rel / 19 - phase) * 1.1
    projected_x = (x_rel + x_warp) * scale
    projected_y = (y_rel + y_warp) * scale
    min_x, min_y = float(projected_x.min()), float(projected_y.min())
    target_x = np.rint(projected_x - min_x + 3).astype(int)
    target_y = np.rint(projected_y - min_y + 3).astype(int)
    width = int(target_x.max()) + 4
    height = int(target_y.max()) + 4
    transformed_codes = np.full((height, width), "DPO", dtype="<U3")
    transformed_mask = np.zeros((height, width), dtype=bool)
    transformed_codes[target_y, target_x] = source[ys, xs]
    transformed_mask[target_y, target_x] = True

    closed = ndimage.binary_closing(transformed_mask, structure=STRUCTURE, iterations=1)
    additions = closed & ~transformed_mask
    fill_new_cells(transformed_codes, transformed_mask, additions)
    transformed_mask |= additions

    mapped_x = np.zeros(mask.shape, dtype=np.int32)
    mapped_y = np.zeros(mask.shape, dtype=np.int32)
    mapped_x[ys, xs] = target_x
    mapped_y[ys, xs] = target_y
    rescued = preserve_codes_and_components(
        source, mask, transformed_codes, transformed_mask, mapped_x, mapped_y
    )
    return transformed_codes, transformed_mask, *rescued


def transform_antarctica(
    source: np.ndarray,
    mask: np.ndarray,
    lon_grid: np.ndarray,
    lat_grid: np.ndarray,
    scale: float,
) -> tuple[np.ndarray, np.ndarray, int, int]:
    ys, xs = np.where(mask)
    longitude = np.radians(lon_grid[ys, xs])
    radius = (90 + lat_grid[ys, xs]) * 4.0
    projected_x = radius * np.sin(longitude) * scale
    projected_y = -radius * np.cos(longitude) * scale * 0.72
    min_x, min_y = float(projected_x.min()), float(projected_y.min())
    target_x = np.rint(projected_x - min_x + 3).astype(int)
    target_y = np.rint(projected_y - min_y + 3).astype(int)
    width, height = int(target_x.max()) + 4, int(target_y.max()) + 4
    codes = np.full((height, width), "DPO", dtype="<U3")
    land = np.zeros((height, width), dtype=bool)
    codes[target_y, target_x] = source[ys, xs]
    land[target_y, target_x] = True
    closed = ndimage.binary_closing(land, structure=STRUCTURE, iterations=2)
    additions = closed & ~land
    fill_new_cells(codes, land, additions)
    land |= additions
    mapped_x = np.zeros(mask.shape, dtype=np.int32)
    mapped_y = np.zeros(mask.shape, dtype=np.int32)
    mapped_x[ys, xs], mapped_y[ys, xs] = target_x, target_y
    rescued = preserve_codes_and_components(source, mask, codes, land, mapped_x, mapped_y)
    return codes, land, *rescued


def irregular_continent(target_area: int) -> tuple[np.ndarray, np.ndarray]:
    width, height = 360, 280
    center = (width // 2, height // 2)
    points = [
        (-128, -48), (-104, -83), (-63, -77), (-31, -105), (8, -88), (48, -101),
        (93, -74), (124, -37), (111, -4), (139, 28), (107, 67), (69, 61),
        (38, 96), (1, 82), (-29, 106), (-61, 76), (-101, 83), (-129, 49),
        (-112, 15), (-143, -11),
    ]
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    draw.polygon([(center[0] + x, center[1] + y) for x, y in points], fill=255)
    base = np.array(image) > 0
    rng = np.random.default_rng(20260720)
    noise = ndimage.gaussian_filter(rng.random(base.shape), sigma=(2.4, 4.7), mode="reflect")
    edge = base ^ ndimage.binary_erosion(base, iterations=6)
    base[edge & (noise < np.quantile(noise[edge], 0.36))] = False
    ratio = math.sqrt(target_area / max(1, int(base.sum())))
    resized = Image.fromarray((base * 255).astype(np.uint8)).resize(
        (max(24, int(round(width * ratio))), max(20, int(round(height * ratio)))),
        Image.Resampling.NEAREST,
    )
    mask = np.array(resized) > 0
    codes = np.full(mask.shape, "DPO", dtype="<U3")
    codes[mask] = "PLN"
    return codes, mask


def valid_position(mask: np.ndarray, blocked: np.ndarray, x: int, y: int) -> bool:
    height, width = mask.shape
    if x < 0 or y < 0 or x + width > blocked.shape[1] or y + height > blocked.shape[0]:
        return False
    boundary = mask ^ ndimage.binary_erosion(mask, structure=STRUCTURE)
    if np.any(boundary & blocked[y : y + height, x : x + width]):
        return False
    return not np.any(mask & blocked[y : y + height, x : x + width])


def find_packed_position(
    mask: np.ndarray,
    occupied: np.ndarray,
    center: tuple[int, int],
    direction: tuple[float, float],
) -> tuple[int, int]:
    blocked = ndimage.binary_dilation(occupied, structure=STRUCTURE, iterations=GAP)
    dx, dy = direction
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    tx, ty = -uy, ux
    region_center = (mask.shape[1] / 2, mask.shape[0] / 2)
    tangent_limit = max(72, min(180, max(mask.shape) // 2))
    candidates: list[tuple[float, int, int]] = []
    for tangent in range(-tangent_limit, tangent_limit + 1, 6):
        for radial in range(0, 760, 3):
            target_x = center[0] + ux * radial + tx * tangent
            target_y = center[1] + uy * radial + ty * tangent
            x = int(round(target_x - region_center[0]))
            y = int(round(target_y - region_center[1]))
            if valid_position(mask, blocked, x, y):
                score = radial + abs(tangent) * 0.18
                candidates.append((score, x, y))
                break
    if not candidates:
        raise RuntimeError(f"方向{direction}に陸塊を配置できません")
    _, x, y = min(candidates)
    return x, y


def paste(
    canvas: np.ndarray,
    owners: np.ndarray,
    codes: np.ndarray,
    mask: np.ndarray,
    x: int,
    y: int,
    owner: int,
) -> None:
    target = owners[y : y + mask.shape[0], x : x + mask.shape[1]]
    if np.any(mask & (target > 0)):
        raise RuntimeError("陸塊が重複しました")
    canvas[y : y + mask.shape[0], x : x + mask.shape[1]][mask] = codes[mask]
    target[mask] = owner


def relabel_land_components(
    owners: np.ndarray,
    center: tuple[int, int],
    antarctica_owner: int,
) -> tuple[np.ndarray, set[int], int]:
    antarctica = owners == antarctica_owner
    labels, count = ndimage.label(owners > 0, structure=STRUCTURE)
    central_label = int(labels[center[1], center[0]])
    if not central_label:
        raise RuntimeError("中央大陸の連結成分を取得できません")
    if central_label != 1:
        central_cells = labels == central_label
        first_cells = labels == 1
        labels[first_cells] = central_label
        labels[central_cells] = 1
    antarctica_labels = set(np.unique(labels[antarctica])) - {0}
    return labels.astype(np.int16), {1, *antarctica_labels}, count


def trim(
    canvas: np.ndarray,
    owners: np.ndarray,
    center: tuple[int, int],
    margin: int = MARGIN,
) -> tuple[np.ndarray, np.ndarray]:
    ys, xs = np.where(owners > 0)
    half_width = max(center[0] - int(xs.min()), int(xs.max()) - center[0]) + margin
    half_height = max(center[1] - int(ys.min()), int(ys.max()) - center[1]) + margin
    x0, x1 = center[0] - half_width, center[0] + half_width + 1
    y0, y1 = center[1] - half_height, center[1] + half_height + 1
    if x0 < 0 or y0 < 0 or x1 > canvas.shape[1] or y1 > canvas.shape[0]:
        raise RuntimeError("中心固定トリミング範囲が作業キャンバスを超えました")
    return canvas[y0:y1, x0:x1].copy(), owners[y0:y1, x0:x1].copy()


def add_ocean(codes: np.ndarray, owners: np.ndarray) -> None:
    water = owners == 0
    distance = ndimage.distance_transform_edt(water)
    codes[water] = "DPO"
    codes[water & (distance <= 1.5)] = "SHF"
    codes[water & (distance > 1.5) & (distance <= 5.5)] = "OCN"


def grow_land_to_fraction(
    canvas: np.ndarray,
    owners: np.ndarray,
    center: tuple[int, int],
    excluded_owners: set[int],
    target_fraction: float = 0.60,
) -> tuple[int, int]:
    original_owners = owners.copy()
    water = original_owners == 0
    grow_seed = np.zeros(owners.shape, dtype=bool)
    for owner in sorted(set(np.unique(owners)) - {0} - excluded_owners):
        labels, count = ndimage.label(owners == owner, structure=STRUCTURE)
        sizes = np.bincount(labels.ravel())
        keep = np.where(sizes >= 500)[0]
        keep = keep[keep > 0]
        grow_seed |= np.isin(labels, keep)
    distance, indices = ndimage.distance_transform_edt(~grow_seed, return_indices=True)
    nearest_owner = original_owners[indices[0], indices[1]]
    nearest_codes = canvas[indices[0], indices[1]]
    owner_max = ndimage.maximum_filter(nearest_owner, size=3, mode="nearest")
    owner_min = ndimage.minimum_filter(nearest_owner, size=3, mode="nearest")
    seam = owner_max != owner_min
    seam = ndimage.binary_dilation(seam, structure=STRUCTURE, iterations=2)
    interior = np.ones(owners.shape, dtype=bool)
    eligible = (
        water
        & interior
        & ~seam
        & (nearest_owner > 0)
        & ~np.isin(nearest_owner, list(excluded_owners))
    )
    fixed_area = owners.size

    chosen = None
    for radius in range(1, 181):
        fill = eligible & (distance <= radius)
        candidate = owners > 0
        candidate |= fill
        fraction = float(candidate.sum()) / fixed_area
        if fraction >= target_fraction:
            chosen = (radius, fill)
            break
    if chosen is None:
        raise RuntimeError("中心方向の海岸変形だけでは陸地率60%へ到達できません")
    radius, fill = chosen
    target_owner = nearest_owner.copy()
    active = original_owners > 0
    owners[fill] = target_owner[fill]
    rng = np.random.default_rng(20260721)
    order = [(-1, 0), (0, 1), (1, 0), (0, -1), (-1, 1), (1, 1), (1, -1), (-1, -1)]
    for layer_index in range(1, radius + 2):
        layer = fill & (distance > layer_index - 1) & (distance <= layer_index)
        if not layer.any():
            continue
        unfilled = layer.copy()
        shift = int(rng.integers(0, len(order)))
        for dy, dx in order[shift:] + order[:shift]:
            source_active = np.roll(active, shift=(dy, dx), axis=(0, 1))
            source_owner = np.roll(owners, shift=(dy, dx), axis=(0, 1))
            valid = unfilled & source_active & (source_owner == target_owner)
            if not valid.any():
                continue
            source_codes = np.roll(canvas, shift=(dy, dx), axis=(0, 1))
            canvas[valid] = source_codes[valid]
            active[valid] = True
            unfilled[valid] = False
        if unfilled.any():
            canvas[unfilled] = nearest_codes[unfilled]
            active[unfilled] = True
    return radius, int(fill.sum())


def resize_codes(codes: np.ndarray, width: int) -> np.ndarray:
    height = max(1, int(round(codes.shape[0] / codes.shape[1] * width)))
    result = read_codes_from_image(
        image_from_code_array(codes).resize((width, height), Image.Resampling.NEAREST)
    )
    result = sanitize_resized_beaches(result)
    for code in np.unique(codes):
        if np.any(result == code):
            continue
        ys, xs = np.where(codes == code)
        x = int(round(float(xs.mean()) / max(1, codes.shape[1] - 1) * (width - 1)))
        y = int(round(float(ys.mean()) / max(1, codes.shape[0] - 1) * (height - 1)))
        result[y, x] = code
    result[result == "TWN"] = "PLN"
    result[height // 2, width // 2] = "TWN"
    return result


def warp_axis(
    codes: np.ndarray,
    owners: np.ndarray,
    axis: int,
    base_weight: float,
    power: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    land = owners > 0
    density = land.mean(axis=1 - axis)
    density /= max(float(density.max()), 1e-9)
    weights = base_weight + (1 - base_weight) * np.power(density, power)
    cumulative = np.concatenate([[0.0], np.cumsum(weights)])
    new_size = max(8, int(round(float(cumulative[-1]))))
    targets = (np.arange(new_size) + 0.5) / new_size * cumulative[-1]
    source_indices = np.searchsorted(cumulative, targets, side="right") - 1
    source_indices = np.clip(source_indices, 0, codes.shape[axis] - 1)
    return (
        np.take(codes, source_indices, axis=axis),
        np.take(owners, source_indices, axis=axis),
        source_indices,
    )


def separate_touching_regions(codes: np.ndarray, owners: np.ndarray) -> int:
    remove = np.zeros(owners.shape, dtype=bool)
    for dy, dx in [(-1, 0), (0, 1), (1, 0), (0, -1), (-1, 1), (1, 1), (1, -1), (-1, -1)]:
        neighbor = np.roll(owners, shift=(dy, dx), axis=(0, 1))
        touching = (owners > 0) & (neighbor > 0) & (owners != neighbor)
        remove |= touching & (owners > neighbor)
    count = int(remove.sum())
    owners[remove] = 0
    codes[remove] = "DPO"
    return count


def rescue_point(
    codes: np.ndarray,
    owners: np.ndarray,
    x: int,
    y: int,
    owner: int,
    code: str,
) -> bool:
    for radius in range(0, 7):
        for py in range(max(0, y - radius), min(owners.shape[0], y + radius + 1)):
            for px in range(max(0, x - radius), min(owners.shape[1], x + radius + 1)):
                if radius and max(abs(px - x), abs(py - y)) != radius:
                    continue
                if owners[py, px] == 0 or owners[py, px] == owner:
                    owners[py, px] = owner
                    codes[py, px] = code
                    return True
    return False


def naturalize_owner_boundary(codes: np.ndarray, owners: np.ndarray, owner: int, max_run: int = 3) -> int:
    added = 0
    for _ in range(20):
        mask = owners == owner
        additions = np.zeros(mask.shape, dtype=bool)
        exposed = [
            (mask & ~np.roll(mask, 1, axis=0), -1, 0),
            (mask & ~np.roll(mask, -1, axis=0), 1, 0),
            (mask & ~np.roll(mask, 1, axis=1), 0, -1),
            (mask & ~np.roll(mask, -1, axis=1), 0, 1),
        ]
        for edge, dy, dx in exposed:
            lines = edge if dy else edge.T
            for line_index, line in enumerate(lines):
                positions = np.where(line)[0]
                for run in np.split(positions, np.where(np.diff(positions) > 1)[0] + 1):
                    if len(run) <= max_run:
                        continue
                    for position in run[max_run - 1 :: max_run]:
                        y, x = (line_index, int(position)) if dy else (int(position), line_index)
                        py, px = y + dy, x + dx
                        if not (0 <= py < owners.shape[0] and 0 <= px < owners.shape[1]):
                            continue
                        neighborhood = owners[max(0, py - 1) : py + 2, max(0, px - 1) : px + 2]
                        if owners[py, px] == 0 and not np.any((neighborhood > 0) & (neighborhood != owner)):
                            additions[py, px] = True
        if not additions.any():
            break
        owners[additions] = owner
        codes[additions] = "PLN"
        added += int(additions.sum())
    return added


def rebuild_central_continent(codes: np.ndarray, owners: np.ndarray) -> int:
    old = owners == 1
    target_area = max(300, int(round(float(old.sum()) * 0.65)))
    owners[old] = 0
    codes[old] = "DPO"
    central_codes, central_mask = irregular_continent(target_area)
    center_x, center_y = owners.shape[1] // 2, owners.shape[0] // 2
    x0 = center_x - central_mask.shape[1] // 2
    y0 = center_y - central_mask.shape[0] // 2
    if x0 < 0 or y0 < 0 or x0 + central_mask.shape[1] > owners.shape[1] or y0 + central_mask.shape[0] > owners.shape[0]:
        raise RuntimeError("最終中央大陸がキャンバス外へ出ます")
    blocked = ndimage.binary_dilation(owners > 0, structure=STRUCTURE, iterations=2)
    available = ~blocked[y0 : y0 + central_mask.shape[0], x0 : x0 + central_mask.shape[1]]
    central_mask &= available
    labels, _ = ndimage.label(central_mask, structure=STRUCTURE)
    label = int(labels[central_mask.shape[0] // 2, central_mask.shape[1] // 2])
    if not label:
        raise RuntimeError("最終中央大陸の中心が他大陸に阻害されています")
    central_mask = labels == label
    target_owners = owners[y0 : y0 + central_mask.shape[0], x0 : x0 + central_mask.shape[1]]
    target_codes = codes[y0 : y0 + central_mask.shape[0], x0 : x0 + central_mask.shape[1]]
    target_owners[central_mask] = 1
    target_codes[central_mask] = central_codes[central_mask]
    return int(central_mask.sum())


def density_compress(
    codes: np.ndarray,
    owners: np.ndarray,
    target_ocean: float = 0.50,
) -> tuple[np.ndarray, np.ndarray, float, int, int]:
    source_codes = codes.copy()
    source_owners = owners.copy()
    labels, component_count = ndimage.label(source_owners > 0, structure=STRUCTURE)
    selected = None
    attempts = []
    for base_weight in (0.24, 0.18, 0.12, 0.08, 0.05, 0.03, 0.015):
        warped_codes, warped_owners, x_indices = warp_axis(
            source_codes, source_owners, 1, base_weight, 1.4
        )
        warped_codes, warped_owners, y_indices = warp_axis(
            warped_codes, warped_owners, 0, base_weight, 1.4
        )
        center_points = np.where(warped_owners == 1)
        center = (int(round(float(center_points[1].mean()))), int(round(float(center_points[0].mean()))))
        land_y, land_x = np.where(warped_owners > 0)
        crop_x0 = max(0, int(land_x.min()) - MARGIN)
        crop_x1 = min(warped_owners.shape[1], int(land_x.max()) + MARGIN + 1)
        crop_y0 = max(0, int(land_y.min()) - MARGIN)
        crop_y1 = min(warped_owners.shape[0], int(land_y.max()) + MARGIN + 1)
        candidate_codes = warped_codes[crop_y0:crop_y1, crop_x0:crop_x1].copy()
        candidate_owners = warped_owners[crop_y0:crop_y1, crop_x0:crop_x1].copy()
        ocean = 1 - float((candidate_owners > 0).mean())
        attempts.append((base_weight, candidate_owners.shape, ocean))
        if ocean <= target_ocean:
            selected = (
                candidate_codes,
                candidate_owners,
                base_weight,
                x_indices,
                y_indices,
                crop_x0,
                crop_y0,
            )
            break
    if selected is None:
        raise RuntimeError(f"非一様座標圧縮でも海面積50%へ到達できません: {attempts}")
    result_codes, result_owners, base_weight, x_indices, y_indices, crop_x0, crop_y0 = selected
    removed_for_seams = separate_touching_regions(result_codes, result_owners)

    rescued_components = 0
    for label in range(1, component_count + 1):
        ys, xs = np.where(labels == label)
        if not xs.size:
            continue
        point = len(xs) // 2
        owner = int(source_owners[ys[point], xs[point]])
        tx = int(np.argmin(np.abs(x_indices - int(round(float(xs.mean()))))))
        ty = int(np.argmin(np.abs(y_indices - int(round(float(ys.mean()))))))
        tx -= crop_x0
        ty -= crop_y0
        tx = min(result_owners.shape[1] - 1, max(0, tx))
        ty = min(result_owners.shape[0] - 1, max(0, ty))
        y0, y1 = max(0, ty - 2), min(result_owners.shape[0], ty + 3)
        x0, x1 = max(0, tx - 2), min(result_owners.shape[1], tx + 3)
        if not np.any(result_owners[y0:y1, x0:x1] == owner):
            if rescue_point(result_codes, result_owners, tx, ty, owner, str(source_codes[ys[point], xs[point]])):
                rescued_components += 1

    rescued_codes = 0
    for code in np.unique(source_codes[source_owners > 0]):
        if np.any((result_owners > 0) & (result_codes == code)):
            continue
        ys, xs = np.where((source_owners > 0) & (source_codes == code))
        tx = int(np.argmin(np.abs(x_indices - int(round(float(xs.mean()))))))
        ty = int(np.argmin(np.abs(y_indices - int(round(float(ys.mean()))))))
        tx -= crop_x0
        ty -= crop_y0
        tx = min(result_owners.shape[1] - 1, max(0, tx))
        ty = min(result_owners.shape[0] - 1, max(0, ty))
        source_owner = int(source_owners[ys[len(ys) // 2], xs[len(xs) // 2]])
        if rescue_point(result_codes, result_owners, tx, ty, source_owner, str(code)):
            rescued_codes += 1
    return result_codes, result_owners, base_weight, removed_for_seams, rescued_components + rescued_codes


def min_interregion_water(owners: np.ndarray) -> int:
    distances = []
    labels = sorted(set(np.unique(owners)) - {0})
    for label in labels:
        other = (owners > 0) & (owners != label)
        if not other.any():
            continue
        distance = ndimage.distance_transform_edt(~other)
        values = distance[owners == label]
        if values.size:
            distances.append(int(math.floor(float(values.min()))) - 1)
    return min(distances) if distances else 0


def straight_run_max(mask: np.ndarray) -> int:
    maximum = 0
    horizontal = [mask & ~np.roll(mask, 1, axis=0), mask & ~np.roll(mask, -1, axis=0)]
    vertical = [mask & ~np.roll(mask, 1, axis=1), mask & ~np.roll(mask, -1, axis=1)]
    for edge in horizontal:
        for row in edge:
            positions = np.where(row)[0]
            for run in np.split(positions, np.where(np.diff(positions) > 1)[0] + 1):
                maximum = max(maximum, len(run))
    for edge in vertical:
        for column in edge.T:
            positions = np.where(column)[0]
            for run in np.split(positions, np.where(np.diff(positions) > 1)[0] + 1):
                maximum = max(maximum, len(run))
    return maximum


def generate(scale: float, json_width: int) -> dict[str, Path]:
    source_hash = file_hash(SOURCE_IMAGE)
    source = read_codes(SOURCE_IMAGE)
    lon, lat = lon_lat_grids(source.shape[1], source.shape[0])
    land = ~np.isin(source, list(WATER))
    antarctica_mask = land & (lat < -60)
    regions = split_macro_regions(land & ~antarctica_mask, lon, lat)

    phases = {
        "Americas + Greenland": 0.4,
        "Europe + Scandinavia": 1.2,
        "Africa + Madagascar": 2.1,
        "Asia": 2.8,
        "Oceania": 3.7,
    }
    transformed: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    rescued_components = rescued_codes = 0
    for name, mask in regions.items():
        codes, region_mask, component_count, code_count = transform_region(
            source, mask, lat, scale, phases[name]
        )
        transformed[name] = (codes, region_mask)
        rescued_components += component_count
        rescued_codes += code_count
    antarctica = transform_antarctica(source, antarctica_mask, lon, lat, scale * 1.35)
    transformed["Antarctica"] = antarctica[:2]
    rescued_components += antarctica[2]
    rescued_codes += antarctica[3]

    existing_area = sum(int(mask.sum()) for name, (_, mask) in transformed.items() if name != "Antarctica")
    central_codes, central_mask = irregular_continent(int(round(existing_area * 0.12)))
    canvas = np.full((1300, 1700), "DPO", dtype="<U3")
    owners = np.zeros(canvas.shape, dtype=np.int16)
    center = (canvas.shape[1] // 2, canvas.shape[0] // 2 - 35)
    central_x = center[0] - central_mask.shape[1] // 2
    central_y = center[1] - central_mask.shape[0] // 2
    paste(canvas, owners, central_codes, central_mask, central_x, central_y, 1)

    directions = {
        "Europe + Scandinavia": (-0.55, -1.0),
        "Asia": (1.0, -0.58),
        "Africa + Madagascar": (-0.58, 0.95),
        "Americas + Greenland": (-1.0, -0.18),
        "Oceania": (1.0, 0.72),
        "Antarctica": (0.0, 1.0),
    }
    placements: dict[str, tuple[int, int]] = {"New central continent": (central_x, central_y)}
    owner = 2
    for name in directions:
        codes, region_mask = transformed[name]
        x, y = find_packed_position(region_mask, owners > 0, center, directions[name])
        paste(canvas, owners, codes, region_mask, x, y, owner)
        placements[name] = (x, y)
        owner += 1

    owners, excluded_growth_owners, packed_component_count = relabel_land_components(
        owners, center, antarctica_owner=owner - 1
    )

    result, result_owners, compression_weight, seam_pixels, compression_rescues = density_compress(
        canvas, owners
    )
    compressed_center_points = np.where(result_owners == 1)
    compressed_center = (
        int(round(float(compressed_center_points[1].mean()))),
        int(round(float(compressed_center_points[0].mean()))),
    )
    growth_radius, grown_pixels = grow_land_to_fraction(
        result,
        result_owners,
        compressed_center,
        excluded_owners=excluded_growth_owners,
        target_fraction=0.66,
    )
    seam_pixels += separate_touching_regions(result, result_owners)
    final_central_area = rebuild_central_continent(result, result_owners)
    naturalized_pixels = naturalize_owner_boundary(result, result_owners, 1)
    result = np.pad(result, MARGIN, constant_values="DPO")
    result_owners = np.pad(result_owners, MARGIN, constant_values=0)
    add_ocean(result, result_owners)
    result[result == "TWN"] = "PLN"
    center_y, center_x = result.shape[0] // 2, result.shape[1] // 2
    if result_owners[center_y, center_x] != 1:
        raise RuntimeError("トリミング後の完全中心が新大陸から外れました")
    result[center_y, center_x] = "TWN"
    map_maker = resize_codes(result, json_width)

    land_fraction = float((result_owners > 0).mean())
    ocean_fraction = 1 - land_fraction
    minimum_water = min_interregion_water(result_owners)
    missing_high = sorted(
        set(np.unique(source[land])) - set(np.unique(result[result_owners > 0]))
    )
    missing_json = sorted(set(np.unique(result)) - set(np.unique(map_maker)))
    center_cross = [
        str(result[center_y, center_x]),
        str(result[center_y - 1, center_x]),
        str(result[center_y + 1, center_x]),
        str(result[center_y, center_x - 1]),
        str(result[center_y, center_x + 1]),
    ]
    if ocean_fraction > 0.40:
        image_from_code_array(result).save("/tmp/fantasy_compact_failed.png")
        raise RuntimeError(
            f"海面積率{ocean_fraction:.1%}が上限40%を超えています "
            f"size={result.shape[1]}x{result.shape[0]} land={int((result_owners > 0).sum())} placements={placements}"
        )
    if not 1 <= minimum_water <= 3:
        image_from_code_array(result).save("/tmp/fantasy_compact_gap_failed.png")
        raise RuntimeError(f"最小海峡{minimum_water}pxが1〜3px外です")
    if missing_high or missing_json:
        raise RuntimeError(f"バイオーム欠落 high={missing_high} json={missing_json}")
    if center_cross != ["TWN", "PLN", "PLN", "PLN", "PLN"]:
        raise RuntimeError(f"中心条件不一致: {center_cross}")
    central_straight = straight_run_max(result_owners == 1)
    if central_straight > 3:
        raise RuntimeError(f"新大陸境界に{central_straight}pxの直線が残っています")
    if source_hash != file_hash(SOURCE_IMAGE):
        raise RuntimeError("元geo画像が変更されました")
    final_component_count = int(ndimage.label(result_owners > 0, structure=STRUCTURE)[1])

    image_path = OUTPUT / f"fantasy_biome_world_compact_{result.shape[1]}x{result.shape[0]}.png"
    json_image_path = OUTPUT / f"fantasy_biome_world_compact_{map_maker.shape[1]}x{map_maker.shape[0]}.png"
    json_path = OUTPUT / f"fantasy_biome_world_compact_{map_maker.shape[1]}x{map_maker.shape[0]}.json"
    audit_path = OUTPUT / "fantasy_biome_world_compact_audit.md"
    image_from_code_array(result).save(image_path)
    image_from_code_array(map_maker).save(json_image_path)
    write_json(map_maker, json_path)
    lines = [
        "# 中心集約型オリジナル世界地図監査",
        "",
        f"- 元画像SHA-256保持: 合格",
        f"- 出力サイズ: {result.shape[1]}×{result.shape[0]}",
        f"- Map Makerサイズ: {map_maker.shape[1]}×{map_maker.shape[0]}",
        f"- 陸地率: {land_fraction:.1%}",
        f"- 海面積率: {ocean_fraction:.1%}",
        f"- 最小海峡: {minimum_water}px",
        f"- 中心5セル: `{' / '.join(center_cross)}`",
        f"- 高解像度バイオーム欠落: {len(missing_high)}",
        f"- JSONバイオーム欠落: {len(missing_json)}",
        f"- 救済した微小島: {rescued_components}",
        f"- 救済した希少バイオーム: {rescued_codes}",
        f"- 大洋圧縮基底ウェイト: {compression_weight:.2f}",
        f"- 海峡復元で除去した接触陸地: {seam_pixels}px",
        f"- 圧縮後に救済した要素: {compression_rescues}",
        f"- 圧縮後の海岸補間半径: {growth_radius}px",
        f"- 圧縮後の海岸補間セル: {grown_pixels}px",
        f"- 新大陸海岸の自然化セル: {naturalized_pixels}px",
        f"- 最終中央大陸面積: {final_central_area}px",
        f"- 新大陸境界の水平・垂直最大連続: {central_straight}px",
        f"- 圧縮前の独立陸塊: {packed_component_count}",
        f"- 圧縮後の独立陸塊: {final_component_count}",
        "",
        "## 配置座標",
        "",
    ]
    lines.extend(f"- {name}: {position}" for name, position in placements.items())
    audit_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"image": image_path, "json_image": json_image_path, "json": json_path, "audit": audit_path}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scale", type=float, default=0.72)
    parser.add_argument("--json-width", type=int, default=512)
    args = parser.parse_args()
    for name, path in generate(args.scale, args.json_width).items():
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()
