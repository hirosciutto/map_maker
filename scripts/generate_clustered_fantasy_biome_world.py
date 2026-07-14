#!/usr/bin/env python3

from __future__ import annotations

import argparse
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_geo_biome_world import image_from_code_array, write_json  # noqa: E402
from generate_fantasy_biome_world import (  # noqa: E402
    SOURCE_IMAGE,
    WATER,
    file_hash,
    lon_lat_grids,
    read_codes,
    read_codes_from_image,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
STRUCTURE = np.ones((3, 3), dtype=np.uint8)
MARGIN = 4
GAP = 2
SEAM_CLEARANCE = 2.25


def source_groups(
    land: np.ndarray,
    lon: np.ndarray,
    lat: np.ndarray,
) -> tuple[dict[str, np.ndarray], np.ndarray]:
    antarctica = land & (lat < -60)
    labels, count = ndimage.label(land & ~antarctica, structure=STRUCTURE)
    groups = {
        "Afro-Eurasia": np.zeros(land.shape, dtype=bool),
        "Americas + Greenland": np.zeros(land.shape, dtype=bool),
        "Oceania": np.zeros(land.shape, dtype=bool),
    }
    for label in range(1, count + 1):
        component = labels == label
        ys, xs = np.where(component)
        if not xs.size:
            continue
        center_lon = float(np.median(lon[ys, xs]))
        center_lat = float(np.median(lat[ys, xs]))
        size = xs.size
        if center_lon < -25 and not (size < 900 and center_lat < 25 and center_lon < -125):
            target = "Americas + Greenland"
        elif center_lon >= 105 and center_lat < 20:
            target = "Oceania"
        elif center_lon < -125 and center_lat < 25:
            target = "Oceania"
        else:
            target = "Afro-Eurasia"
        groups[target] |= component
    groups["Antarctica"] = antarctica
    return groups, labels


def region_bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask)
    if not xs.size:
        raise RuntimeError("空の陸塊を変形しようとしました")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def row_resample_region(
    source: np.ndarray,
    mask: np.ndarray,
    lat: np.ndarray,
    scale: float,
    phase: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x0, y0, x1, y1 = region_bbox(mask)
    crop_codes = source[y0:y1, x0:x1]
    crop_mask = mask[y0:y1, x0:x1]
    source_parts, _ = ndimage.label(crop_mask, structure=STRUCTURE)
    target_height = max(8, int(round(crop_mask.shape[0] * scale)))
    target_width = max(8, int(round(crop_mask.shape[1] * scale))) + 12
    codes = np.full((target_height, target_width), "DPO", dtype="<U3")
    parts = np.zeros((target_height, target_width), dtype=np.int32)
    for target_y in range(target_height):
        source_y = min(crop_mask.shape[0] - 1, int(round(target_y / scale)))
        latitude = float(lat[y0 + source_y, 0])
        high = np.clip((abs(latitude) - 55) / 30, 0, 1)
        equal_area = np.clip(
            math.cos(math.radians(abs(latitude))) / math.cos(math.radians(55)),
            0.38,
            1.0,
        )
        latitude_factor = 1 - high * (1 - equal_area)
        row_width = max(4, int(round(crop_mask.shape[1] * scale * latitude_factor)))
        source_indices = np.clip(
            np.rint(np.linspace(0, crop_mask.shape[1] - 1, row_width)).astype(int),
            0,
            crop_mask.shape[1] - 1,
        )
        drift = int(round(math.sin(target_y / 27 + phase) * 2.2 + math.sin(target_y / 11 - phase) * 0.8))
        start = (target_width - row_width) // 2 + drift
        start = min(target_width - row_width, max(0, start))
        row_mask = crop_mask[source_y, source_indices]
        target_x = np.arange(start, start + row_width)[row_mask]
        codes[target_y, target_x] = crop_codes[source_y, source_indices][row_mask]
        parts[target_y, target_x] = source_parts[source_y, source_indices][row_mask]

    land = parts > 0
    closed = ndimage.binary_closing(land, structure=STRUCTURE, iterations=1)
    additions = closed & ~land
    if additions.any():
        _, nearest = ndimage.distance_transform_edt(~land, return_indices=True)
        codes[additions] = codes[nearest[0][additions], nearest[1][additions]]
        parts[additions] = parts[nearest[0][additions], nearest[1][additions]]
    return codes, parts > 0, parts


def polar_antarctica(
    source: np.ndarray,
    mask: np.ndarray,
    lon: np.ndarray,
    lat: np.ndarray,
    scale: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ys, xs = np.where(mask)
    longitude = np.radians(lon[ys, xs])
    radius = (90 + lat[ys, xs]) * 3.4 * scale
    projected_x = radius * np.sin(longitude)
    projected_y = -radius * np.cos(longitude) * 0.70
    target_x = np.rint(projected_x - projected_x.min() + 3).astype(int)
    target_y = np.rint(projected_y - projected_y.min() + 3).astype(int)
    codes = np.full((int(target_y.max()) + 4, int(target_x.max()) + 4), "DPO", dtype="<U3")
    parts = np.zeros(codes.shape, dtype=np.int32)
    source_parts, _ = ndimage.label(mask, structure=STRUCTURE)
    codes[target_y, target_x] = source[ys, xs]
    parts[target_y, target_x] = source_parts[ys, xs]
    land = parts > 0
    closed = ndimage.binary_closing(land, structure=STRUCTURE, iterations=2)
    additions = closed & ~land
    if additions.any():
        _, nearest = ndimage.distance_transform_edt(~land, return_indices=True)
        codes[additions] = codes[nearest[0][additions], nearest[1][additions]]
        parts[additions] = parts[nearest[0][additions], nearest[1][additions]]
    return codes, parts > 0, parts


def compact_islands(
    codes: np.ndarray,
    parts: np.ndarray,
    gap: int = GAP,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    part_ids, sizes = np.unique(parts[parts > 0], return_counts=True)
    if not part_ids.size:
        return codes, parts > 0, parts, 0
    order = part_ids[np.argsort(sizes)[::-1]]
    main_id = int(order[0])
    result_codes = np.full(codes.shape, "DPO", dtype="<U3")
    result_parts = np.zeros(parts.shape, dtype=np.int32)
    main = parts == main_id
    result_codes[main] = codes[main]
    result_parts[main] = main_id
    moved = 0
    for part_id in order[1:]:
        component = parts == int(part_id)
        ys, xs = np.where(component)
        occupied_y, occupied_x = np.where(result_parts > 0)
        source_center = np.array([float(xs.mean()), float(ys.mean())])
        target_center = np.array([float(occupied_x.mean()), float(occupied_y.mean())])
        vector = target_center - source_center
        distance = float(np.hypot(*vector))
        if distance <= gap + 1:
            best_dx = best_dy = 0
        else:
            unit = vector / distance
            best_dx = best_dy = 0
            previous = None
            blocked = ndimage.binary_dilation(
                result_parts > 0, structure=STRUCTURE, iterations=gap
            )
            for step in range(1, int(distance) + 1):
                dx = int(round(unit[0] * step))
                dy = int(round(unit[1] * step))
                if previous == (dx, dy):
                    continue
                previous = (dx, dy)
                moved_x = xs + dx
                moved_y = ys + dy
                if (
                    moved_x.min() < 0
                    or moved_y.min() < 0
                    or moved_x.max() >= parts.shape[1]
                    or moved_y.max() >= parts.shape[0]
                    or np.any(blocked[moved_y, moved_x])
                ):
                    break
                best_dx, best_dy = dx, dy
        target_x = xs + best_dx
        target_y = ys + best_dy
        result_codes[target_y, target_x] = codes[ys, xs]
        result_parts[target_y, target_x] = int(part_id)
        if best_dx or best_dy:
            moved += 1
    return result_codes, result_parts > 0, result_parts, moved


def valid_position(mask: np.ndarray, blocked: np.ndarray, x: int, y: int) -> bool:
    height, width = mask.shape
    if x < 0 or y < 0 or x + width > blocked.shape[1] or y + height > blocked.shape[0]:
        return False
    return not np.any(mask & blocked[y : y + height, x : x + width])


def packed_position(
    mask: np.ndarray,
    occupied: np.ndarray,
    anchor: tuple[int, int],
    direction: tuple[float, float],
) -> tuple[int, int]:
    length = math.hypot(*direction)
    ux, uy = direction[0] / length, direction[1] / length
    tx, ty = -uy, ux
    center_x, center_y = mask.shape[1] / 2, mask.shape[0] / 2
    blocked = ndimage.binary_dilation(occupied, structure=STRUCTURE, iterations=GAP)
    candidates: list[tuple[float, int, int]] = []
    for tangent in range(-160, 161, 4):
        for radial in range(0, 850, 2):
            x = int(round(anchor[0] + ux * radial + tx * tangent - center_x))
            y = int(round(anchor[1] + uy * radial + ty * tangent - center_y))
            if valid_position(mask, blocked, x, y):
                candidates.append((radial + abs(tangent) * 0.2, x, y))
                break
    if not candidates:
        raise RuntimeError(f"陸塊を方向{direction}へ配置できません")
    _, x, y = min(candidates)
    return x, y


def paste(
    canvas: np.ndarray,
    owners: np.ndarray,
    parts_canvas: np.ndarray,
    codes: np.ndarray,
    mask: np.ndarray,
    parts: np.ndarray,
    position: tuple[int, int],
    owner: int,
    part_offset: int,
) -> int:
    x, y = position
    target = owners[y : y + mask.shape[0], x : x + mask.shape[1]]
    if np.any(mask & (target > 0)):
        raise RuntimeError("配置する陸塊同士が重複しました")
    canvas[y : y + mask.shape[0], x : x + mask.shape[1]][mask] = codes[mask]
    target[mask] = owner
    target_parts = parts_canvas[y : y + mask.shape[0], x : x + mask.shape[1]]
    target_parts[mask] = parts[mask] + part_offset
    return part_offset + int(parts.max()) + 1


def warp_axis(
    codes: np.ndarray,
    owners: np.ndarray,
    parts: np.ndarray,
    axis: int,
    base_weight: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    density = (owners > 0).mean(axis=1 - axis)
    density /= max(float(density.max()), 1e-9)
    weights = base_weight + (1 - base_weight) * np.power(density, 1.35)
    cumulative = np.concatenate([[0.0], np.cumsum(weights)])
    target_size = max(8, int(round(float(cumulative[-1]))))
    targets = (np.arange(target_size) + 0.5) / target_size * cumulative[-1]
    indices = np.clip(
        np.searchsorted(cumulative, targets, side="right") - 1,
        0,
        codes.shape[axis] - 1,
    )
    return (
        np.take(codes, indices, axis=axis),
        np.take(owners, indices, axis=axis),
        np.take(parts, indices, axis=axis),
    )


def vertical_water_seam(owners: np.ndarray, clearance: float) -> np.ndarray | None:
    water = owners == 0
    safe = water & (ndimage.distance_transform_edt(water) > clearance)
    height, width = safe.shape
    if width <= MARGIN * 2 + 1:
        return None
    cost = np.full(width, np.inf, dtype=np.float64)
    cost[safe[0]] = 0.0
    predecessors = np.zeros((height, width), dtype=np.int8)
    columns = np.arange(width)
    center = (width - 1) / 2
    edge_bias = np.abs(columns - center) / max(center, 1)
    for y in range(1, height):
        left = np.concatenate(([np.inf], cost[:-1]))
        middle = cost
        right = np.concatenate((cost[1:], [np.inf]))
        choices = np.stack((left, middle, right))
        selected = np.argmin(choices, axis=0)
        next_cost = choices[selected, columns]
        next_cost += 1.0 + edge_bias * 0.002
        next_cost[~safe[y]] = np.inf
        predecessors[y] = selected.astype(np.int8) - 1
        cost = next_cost
    if not np.isfinite(cost).any():
        return None
    seam = np.empty(height, dtype=np.int32)
    seam[-1] = int(np.argmin(cost))
    for y in range(height - 1, 0, -1):
        seam[y - 1] = seam[y] + int(predecessors[y, seam[y]])
    return seam


def remove_vertical_seam(array: np.ndarray, seam: np.ndarray) -> np.ndarray:
    keep = np.ones(array.shape, dtype=bool)
    keep[np.arange(array.shape[0]), seam] = False
    return array[keep].reshape(array.shape[0], array.shape[1] - 1)


def carve_water_seams(
    codes: np.ndarray,
    owners: np.ndarray,
    parts: np.ndarray,
    axis: int,
    clearance: float = SEAM_CLEARANCE,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    if axis == 0:
        codes, owners, parts = codes.T, owners.T, parts.T
    removed = 0
    while True:
        seam = vertical_water_seam(owners, clearance)
        if seam is None:
            break
        codes = remove_vertical_seam(codes, seam)
        owners = remove_vertical_seam(owners, seam)
        parts = remove_vertical_seam(parts, seam)
        removed += 1
    if axis == 0:
        codes, owners, parts = codes.T, owners.T, parts.T
    return codes, owners, parts, removed


def separate_macro_regions(codes: np.ndarray, owners: np.ndarray, parts: np.ndarray) -> int:
    remove = np.zeros(owners.shape, dtype=bool)
    for dy, dx in [(-1, 0), (0, 1), (1, 0), (0, -1), (-1, -1), (-1, 1), (1, -1), (1, 1)]:
        neighbor = np.roll(owners, (dy, dx), axis=(0, 1))
        touching = (owners > 0) & (neighbor > 0) & (owners != neighbor)
        remove |= touching & (owners > neighbor)
    codes[remove] = "DPO"
    owners[remove] = 0
    parts[remove] = 0
    return int(remove.sum())


def major_component_ratios(owners: np.ndarray) -> dict[int, float]:
    ratios = {}
    for owner in sorted(set(np.unique(owners)) - {0}):
        mask = owners == owner
        labels, _ = ndimage.label(mask, structure=STRUCTURE)
        sizes = np.bincount(labels.ravel())[1:]
        ratios[owner] = float(sizes.max() / mask.sum()) if sizes.size else 0.0
    return ratios


def main_part_ids(owners: np.ndarray, parts: np.ndarray) -> dict[int, int]:
    result = {}
    for owner in sorted(set(np.unique(owners)) - {0}):
        values = parts[(owners == owner) & (parts > 0)]
        if values.size:
            result[owner] = int(Counter(values.tolist()).most_common(1)[0][0])
    return result


def part_connectivity(parts: np.ndarray, part_ids: dict[int, int]) -> dict[int, float]:
    result = {}
    for owner, part_id in part_ids.items():
        mask = parts == part_id
        labels, _ = ndimage.label(mask, structure=STRUCTURE)
        sizes = np.bincount(labels.ravel())[1:]
        result[owner] = float(sizes.max() / mask.sum()) if sizes.size else 0.0
    return result


def tracked_major_parts(owners: np.ndarray, parts: np.ndarray) -> dict[int, int]:
    tracked = {}
    for owner in sorted(set(np.unique(owners)) - {0}):
        values = parts[(owners == owner) & (parts > 0)]
        counts = Counter(values.tolist())
        threshold = max(80, int(round(values.size * 0.025)))
        for part_id, count in counts.items():
            if count >= threshold:
                tracked[int(part_id)] = owner
    return tracked


def tracked_connectivity(parts: np.ndarray, tracked: dict[int, int]) -> dict[int, float]:
    result = {}
    for part_id in tracked:
        mask = parts == part_id
        labels, _ = ndimage.label(mask, structure=STRUCTURE)
        sizes = np.bincount(labels.ravel())[1:]
        result[part_id] = float(sizes.max() / mask.sum()) if sizes.size else 0.0
    return result


def line_cells(start: tuple[int, int], end: tuple[int, int]) -> list[tuple[int, int]]:
    y0, x0 = start
    y1, x1 = end
    steps = max(abs(y1 - y0), abs(x1 - x0))
    if not steps:
        return [start]
    return [
        (
            int(round(y0 + (y1 - y0) * step / steps)),
            int(round(x0 + (x1 - x0) * step / steps)),
        )
        for step in range(steps + 1)
    ]


def repair_tracked_parts(
    codes: np.ndarray,
    owners: np.ndarray,
    parts: np.ndarray,
    tracked: dict[int, int],
    max_gap: int = 3,
) -> tuple[bool, int]:
    repaired = 0
    for part_id, owner in tracked.items():
        for _ in range(8):
            mask = parts == part_id
            labels, count = ndimage.label(mask, structure=STRUCTURE)
            if count <= 1:
                break
            sizes = np.bincount(labels.ravel())
            main_label = int(np.argmax(sizes[1:]) + 1)
            main = labels == main_label
            distance, nearest = ndimage.distance_transform_edt(~main, return_indices=True)
            best = None
            for label in range(1, count + 1):
                if label == main_label:
                    continue
                fragment = labels == label
                fragment_y, fragment_x = np.where(fragment)
                distances = distance[fragment]
                point = int(np.argmin(distances))
                gap = float(distances[point])
                candidate = (gap, int(fragment_y[point]), int(fragment_x[point]))
                if best is None or candidate < best:
                    best = candidate
            if best is None or best[0] > max_gap + 1:
                return False, repaired
            _, fragment_y, fragment_x = best
            main_y = int(nearest[0, fragment_y, fragment_x])
            main_x = int(nearest[1, fragment_y, fragment_x])
            cells = line_cells((fragment_y, fragment_x), (main_y, main_x))
            for y, x in cells:
                neighborhood = owners[max(0, y - 1) : y + 2, max(0, x - 1) : x + 2]
                if owners[y, x] not in (0, owner) or np.any((neighborhood > 0) & (neighborhood != owner)):
                    return False, repaired
            source_code = str(codes[main_y, main_x])
            for y, x in cells:
                if parts[y, x] != part_id:
                    codes[y, x] = source_code
                    owners[y, x] = owner
                    parts[y, x] = part_id
                    repaired += 1
        if tracked_connectivity(parts, {part_id: owner})[part_id] != 1.0:
            return False, repaired
    return True, repaired


def restore_missing_biomes(
    source: np.ndarray,
    source_groups_by_name: dict[str, np.ndarray],
    result: np.ndarray,
    owners: np.ndarray,
    owner_names: dict[int, str],
) -> int:
    restored = 0
    present = set(np.unique(result[owners > 0]))
    missing = sorted(set(np.unique(source[~np.isin(source, list(WATER))])) - present)
    used_cells: set[tuple[int, int]] = set()
    for code in missing:
        owner = next(
            number
            for number, name in owner_names.items()
            if np.any(source_groups_by_name[name] & (source == code))
        )
        interior = (owners == owner) & ndimage.binary_erosion(owners == owner, structure=STRUCTURE)
        ys, xs = np.where(interior if interior.any() else owners == owner)
        start = int(round(len(xs) * ((restored + 1) * 0.38196601125 % 1)))
        point = -1
        for offset in range(len(xs)):
            candidate = (start + offset) % len(xs)
            if (int(ys[candidate]), int(xs[candidate])) not in used_cells:
                point = candidate
                break
        if point < 0:
            raise RuntimeError(f"希少バイオーム{code}の復元先がありません")
        cell = (int(ys[point]), int(xs[point]))
        result[cell] = code
        used_cells.add(cell)
        restored += 1
    return restored


def trim(
    codes: np.ndarray,
    owners: np.ndarray,
    parts: np.ndarray,
    margin: int = MARGIN,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ys, xs = np.where(owners > 0)
    y0, y1 = max(0, int(ys.min()) - margin), min(codes.shape[0], int(ys.max()) + margin + 1)
    x0, x1 = max(0, int(xs.min()) - margin), min(codes.shape[1], int(xs.max()) + margin + 1)
    cropped_codes = codes[y0:y1, x0:x1].copy()
    cropped_owners = owners[y0:y1, x0:x1].copy()
    cropped_parts = parts[y0:y1, x0:x1].copy()
    if margin:
        cropped_y, cropped_x = np.where(cropped_owners > 0)
        padding = (
            (max(0, margin - int(cropped_y.min())), max(0, margin - int(cropped_owners.shape[0] - 1 - cropped_y.max()))),
            (max(0, margin - int(cropped_x.min())), max(0, margin - int(cropped_owners.shape[1] - 1 - cropped_x.max()))),
        )
        if any(value for axis in padding for value in axis):
            cropped_codes = np.pad(cropped_codes, padding, constant_values="DPO")
            cropped_owners = np.pad(cropped_owners, padding, constant_values=0)
            cropped_parts = np.pad(cropped_parts, padding, constant_values=0)
    return cropped_codes, cropped_owners, cropped_parts


def move_antarctica_to_bottom(
    codes: np.ndarray,
    owners: np.ndarray,
    parts: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    antarctica = owners == 4
    ant_y, ant_x = np.where(antarctica)
    ant_y0, ant_y1 = int(ant_y.min()), int(ant_y.max()) + 1
    ant_x0, ant_x1 = int(ant_x.min()), int(ant_x.max()) + 1
    ant_codes = codes[ant_y0:ant_y1, ant_x0:ant_x1].copy()
    ant_owners = owners[ant_y0:ant_y1, ant_x0:ant_x1].copy()
    ant_parts = parts[ant_y0:ant_y1, ant_x0:ant_x1].copy()
    ant_local = ant_owners == 4
    ant_codes[~ant_local] = "DPO"
    ant_owners[~ant_local] = 0
    ant_parts[~ant_local] = 0

    main_codes = codes.copy()
    main_owners = owners.copy()
    main_parts = parts.copy()
    main_codes[antarctica] = "DPO"
    main_owners[antarctica] = 0
    main_parts[antarctica] = 0
    main_codes, main_owners, main_parts = trim(main_codes, main_owners, main_parts, margin=0)

    width = max(main_codes.shape[1], ant_codes.shape[1]) + MARGIN * 2
    height = main_codes.shape[0] + ant_codes.shape[0] + GAP
    result_codes = np.full((height, width), "DPO", dtype="<U3")
    result_owners = np.zeros((height, width), dtype=np.int16)
    result_parts = np.zeros((height, width), dtype=np.int32)
    main_x = (width - main_codes.shape[1]) // 2
    result_codes[: main_codes.shape[0], main_x : main_x + main_codes.shape[1]] = main_codes
    result_owners[: main_owners.shape[0], main_x : main_x + main_owners.shape[1]] = main_owners
    result_parts[: main_parts.shape[0], main_x : main_x + main_parts.shape[1]] = main_parts
    blocked = ndimage.binary_dilation(result_owners > 0, structure=STRUCTURE, iterations=GAP)
    center_x = (width - ant_codes.shape[1]) // 2
    min_y = max(0, main_codes.shape[0] - ant_codes.shape[0] + 1)
    candidates = []
    for ant_y in range(min_y, main_codes.shape[0] + GAP + 1):
        for offset in range(0, width):
            for signed_offset in ({0} if offset == 0 else {-offset, offset}):
                ant_x = center_x + signed_offset
                if valid_position(ant_local, blocked, ant_x, ant_y):
                    score = (ant_y - min_y) + abs(signed_offset) * 0.5
                    candidates.append((score, ant_x, ant_y))
    if not candidates:
        raise RuntimeError("南極を他大陸の南側へ再配置できません")
    _, ant_x, ant_y = min(candidates)
    ant_target = result_owners[ant_y : ant_y + ant_codes.shape[0], ant_x : ant_x + ant_codes.shape[1]]
    ant_code_target = result_codes[ant_y : ant_y + ant_codes.shape[0], ant_x : ant_x + ant_codes.shape[1]]
    ant_part_target = result_parts[ant_y : ant_y + ant_parts.shape[0], ant_x : ant_x + ant_parts.shape[1]]
    ant_target[ant_local] = 4
    ant_code_target[ant_local] = ant_codes[ant_local]
    ant_part_target[ant_local] = ant_parts[ant_local]
    return trim(result_codes, result_owners, result_parts, margin=MARGIN)


def add_ocean(codes: np.ndarray, owners: np.ndarray) -> None:
    water = owners == 0
    distance = ndimage.distance_transform_edt(water)
    codes[water] = "DPO"
    codes[water & (distance <= 1.5)] = "SHF"
    codes[water & (distance > 1.5) & (distance <= 5.5)] = "OCN"


def resize_codes(codes: np.ndarray, width: int) -> np.ndarray:
    from PIL import Image

    height = max(1, int(round(codes.shape[0] / codes.shape[1] * width)))
    result = read_codes_from_image(
        image_from_code_array(codes).resize((width, height), Image.Resampling.NEAREST)
    )
    for code in np.unique(codes):
        if np.any(result == code):
            continue
        ys, xs = np.where(codes == code)
        x = int(round(float(xs.mean()) / max(1, codes.shape[1] - 1) * (width - 1)))
        y = int(round(float(ys.mean()) / max(1, codes.shape[0] - 1) * (height - 1)))
        result[y, x] = code
    return result


def generate(scale: float, json_width: int) -> dict[str, Path]:
    print("[1/6] source", flush=True)
    source_hash = file_hash(SOURCE_IMAGE)
    source = read_codes(SOURCE_IMAGE)
    lon, lat = lon_lat_grids(source.shape[1], source.shape[0])
    land = ~np.isin(source, list(WATER))
    groups, _ = source_groups(land, lon, lat)

    print("[2/6] transform", flush=True)
    transformed = {}
    phases = {"Afro-Eurasia": 0.8, "Americas + Greenland": 1.9, "Oceania": 3.1}
    for name in ("Afro-Eurasia", "Americas + Greenland"):
        transformed[name] = row_resample_region(source, groups[name], lat, scale, phases[name])
    dateline_roll = source.shape[1] // 2
    transformed["Oceania"] = row_resample_region(
        np.roll(source, dateline_roll, axis=1),
        np.roll(groups["Oceania"], dateline_roll, axis=1),
        lat,
        scale,
        phases["Oceania"],
    )
    transformed["Antarctica"] = polar_antarctica(source, groups["Antarctica"], lon, lat, scale * 1.12)
    moved_islands = 0
    for name in ("Afro-Eurasia", "Americas + Greenland", "Oceania"):
        codes, _, region_parts = transformed[name]
        codes, mask, region_parts, moved = compact_islands(codes, region_parts)
        transformed[name] = (codes, mask, region_parts)
        moved_islands += moved

    print("[3/6] pack", flush=True)
    canvas = np.full((1800, 2600), "DPO", dtype="<U3")
    owners = np.zeros(canvas.shape, dtype=np.int16)
    parts = np.zeros(canvas.shape, dtype=np.int32)
    anchor = (canvas.shape[1] // 2, canvas.shape[0] // 2 - 100)
    owner_names = {1: "Afro-Eurasia", 2: "Americas + Greenland", 3: "Oceania", 4: "Antarctica"}
    placements = {}
    part_offset = 0

    codes, mask, region_parts = transformed["Afro-Eurasia"]
    position = (anchor[0] - mask.shape[1] // 2, anchor[1] - mask.shape[0] // 2)
    part_offset = paste(canvas, owners, parts, codes, mask, region_parts, position, 1, part_offset)
    placements["Afro-Eurasia"] = position

    for name, owner, direction in [
        ("Americas + Greenland", 2, (-1.0, -0.08)),
        ("Oceania", 3, (0.92, 0.72)),
        ("Antarctica", 4, (0.0, 1.0)),
    ]:
        codes, mask, region_parts = transformed[name]
        position = packed_position(mask, owners > 0, anchor, direction)
        part_offset = paste(canvas, owners, parts, codes, mask, region_parts, position, owner, part_offset)
        placements[name] = position

    source_ratios = major_component_ratios(owners)
    tracked_main_parts = main_part_ids(owners, parts)
    source_main_connectivity = part_connectivity(parts, tracked_main_parts)
    tracked_parts = tracked_major_parts(owners, parts)
    source_tracked_connectivity = tracked_connectivity(parts, tracked_parts)
    print("[4/6] compress water-only seams", flush=True)
    result, result_owners, result_parts = trim(canvas, owners, parts)
    result, result_owners, result_parts = move_antarctica_to_bottom(
        result, result_owners, result_parts
    )
    transformed_land = int((result_owners > 0).sum())
    seam_counts = [0, 0]
    for _ in range(3):
        changed = 0
        for axis in (1, 0):
            result, result_owners, result_parts, removed = carve_water_seams(
                result, result_owners, result_parts, axis
            )
            seam_counts[axis] += removed
            changed += removed
        if not changed:
            break
    result, result_owners, result_parts = move_antarctica_to_bottom(
        result, result_owners, result_parts
    )
    result, result_owners, result_parts = trim(result, result_owners, result_parts)
    if int((result_owners > 0).sum()) != transformed_land:
        raise RuntimeError("海域圧縮中に陸地ピクセルが変化しました")
    ocean_fraction = 1 - float((result_owners > 0).mean())
    final_ratios = major_component_ratios(result_owners)
    final_main_connectivity = part_connectivity(result_parts, tracked_main_parts)
    final_tracked_connectivity = tracked_connectivity(result_parts, tracked_parts)
    print("[5/6] validate", flush=True)
    add_ocean(result, result_owners)
    restored = restore_missing_biomes(source, groups, result, result_owners, owner_names)
    map_maker = resize_codes(result, json_width)

    missing_high = sorted(set(np.unique(source[land])) - set(np.unique(result[result_owners > 0])))
    missing_json = sorted(set(np.unique(result)) - set(np.unique(map_maker)))
    if missing_high or missing_json:
        raise RuntimeError(f"バイオーム欠落 high={missing_high} json={missing_json}")
    if source_hash != file_hash(SOURCE_IMAGE):
        raise RuntimeError("元geo画像が変更されました")
    degraded_parts = [
        part_id
        for part_id, before in source_tracked_connectivity.items()
        if final_tracked_connectivity.get(part_id, 0.0) + 1e-9 < before
    ]
    if degraded_parts:
        raise RuntimeError(f"主要陸塊が新たに分断されました: {degraded_parts}")
    antarctica_y = np.where(result_owners == 4)[0]
    other_y = np.where((result_owners > 0) & (result_owners != 4))[0]
    if int(antarctica_y.max()) <= int(other_y.max()):
        raise RuntimeError("南極南端が世界の最下部に配置されていません")

    image_path = OUTPUT / f"fantasy_biome_world_clustered_{result.shape[1]}x{result.shape[0]}.png"
    json_image_path = OUTPUT / f"fantasy_biome_world_clustered_{map_maker.shape[1]}x{map_maker.shape[0]}.png"
    json_path = OUTPUT / f"fantasy_biome_world_clustered_{map_maker.shape[1]}x{map_maker.shape[0]}.json"
    audit_path = OUTPUT / "fantasy_biome_world_clustered_audit.md"
    image_from_code_array(result).save(image_path)
    image_from_code_array(map_maker).save(json_image_path)
    write_json(map_maker, json_path)
    print("[6/6] output", flush=True)
    audit = [
        "# 非分割・中心集約型オリジナル世界地図監査",
        "",
        "- 元画像SHA-256保持: 合格",
        f"- 出力サイズ: {result.shape[1]}×{result.shape[0]}",
        f"- Map Makerサイズ: {map_maker.shape[1]}×{map_maker.shape[0]}",
        f"- 海面積率: {ocean_fraction:.1%}",
        "- 全体縮小: なし",
        f"- 海上シーム切除: 横方向{seam_counts[1]}本 / 縦方向{seam_counts[0]}本",
        f"- 海峡保護距離: {SEAM_CLEARANCE:.2f}px",
        f"- 最寄り大陸へ追従移動した島: {moved_islands}",
        f"- 復元した希少バイオーム: {restored}",
        "- 海域圧縮で削除した陸地セル: 0",
        f"- 高解像度バイオーム欠落: {len(missing_high)}",
        f"- JSONバイオーム欠落: {len(missing_json)}",
        "- 高緯度補正: 緯度別等積近似（陸塊単位）",
        "- 南極: 極投影近似で再構築し最下部へ配置",
        "",
        "## 主要大陸の最大連結成分比",
        "",
    ]
    for owner, name in owner_names.items():
        audit.append(f"- {name}: {source_ratios[owner]:.1%} → {final_ratios[owner]:.1%}")
    audit.extend(["", "## 主要大陸本体の連結維持率", ""])
    for owner, name in owner_names.items():
        audit.append(
            f"- {name}: {source_main_connectivity.get(owner, 0):.1%} → "
            f"{final_main_connectivity.get(owner, 0):.1%}"
        )
    audit.extend(["", "## 主要陸塊の個別追跡", ""])
    for owner, name in owner_names.items():
        owner_parts = [part for part, part_owner in tracked_parts.items() if part_owner == owner]
        preserved = sum(
            final_tracked_connectivity.get(part, 0) + 1e-9
            >= source_tracked_connectivity.get(part, 0)
            for part in owner_parts
        )
        audit.append(f"- {name}: {preserved}/{len(owner_parts)}成分を非分割で保持")
    audit.extend(["", "## 配置座標", ""])
    audit.extend(f"- {name}: {position}" for name, position in placements.items())
    audit_path.write_text("\n".join(audit) + "\n", encoding="utf-8")
    return {"image": image_path, "json_image": json_image_path, "json": json_path, "audit": audit_path}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--json-width", type=int, default=512)
    args = parser.parse_args()
    for name, path in generate(args.scale, args.json_width).items():
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()
