#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_geo_biome_world import (  # noqa: E402
    BIOMES,
    RGB,
    image_from_code_array,
    sanitize_resized_beaches,
    write_json,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"
SOURCE_IMAGE = OUTPUT / "geo_biome_world_1440x720.png"
WATER = {"TRN", "DPO", "OCN", "SHF"}
LAND_STRUCTURE = np.ones((3, 3), dtype=np.uint8)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def read_codes(path: Path) -> np.ndarray:
    pixels = np.array(Image.open(path).convert("RGB"))
    codes = np.full(pixels.shape[:2], "???", dtype="<U3")
    for code, color in RGB.items():
        codes[np.all(pixels == color, axis=2)] = code
    unknown = np.unique(codes[codes == "???"])
    if unknown.size:
        raise RuntimeError("入力画像にバイオームパレット外の色があります")
    return codes


def lon_lat_grids(width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    lon = np.linspace(-180 + 90 / width, 180 - 90 / width, width)[None, :]
    lat = np.linspace(90 - 90 / height, -90 + 90 / height, height)[:, None]
    return np.broadcast_to(lon, (height, width)), np.broadcast_to(lat, (height, width))


def lonlat_pixel(lon: float, lat: float, width: int, height: int) -> tuple[int, int]:
    return (
        min(width - 1, max(0, int(round((lon + 180) / 360 * (width - 1))))),
        min(height - 1, max(0, int(round((90 - lat) / 180 * (height - 1))))),
    )


def cut_land_corridor(mask: np.ndarray, points: list[tuple[float, float]], width: int) -> None:
    image = Image.new("L", (mask.shape[1], mask.shape[0]), 0)
    draw = ImageDraw.Draw(image)
    pixels = [lonlat_pixel(lon, lat, mask.shape[1], mask.shape[0]) for lon, lat in points]
    draw.line(pixels, fill=255, width=width, joint="curve")
    mask[np.array(image) > 0] = False


def split_macro_regions(main_land: np.ndarray, lon: np.ndarray, lat: np.ndarray) -> dict[str, np.ndarray]:
    partition = main_land.copy()
    cut_land_corridor(partition, [(-10, 35), (-5, 36), (0, 37)], 8)
    cut_land_corridor(partition, [(31, 33), (33, 29), (35, 24), (39, 18), (44, 11), (49, 8)], 9)
    cut_land_corridor(
        partition,
        [(20, 25), (24, 34), (26, 38), (29, 41), (36, 43), (45, 45), (52, 48), (57, 55), (60, 65), (66, 75), (72, 89), (75, 90)],
        10,
    )
    labels, count = ndimage.label(partition, structure=LAND_STRUCTURE)

    def seed_label(seed_lon: float, seed_lat: float) -> int:
        x, y = lonlat_pixel(seed_lon, seed_lat, partition.shape[1], partition.shape[0])
        label = int(labels[y, x])
        if label:
            return label
        for radius in range(1, 10):
            area = labels[max(0, y - radius) : y + radius + 1, max(0, x - radius) : x + radius + 1]
            values = area[area > 0]
            if values.size:
                return int(Counter(values.ravel()).most_common(1)[0][0])
        raise RuntimeError(f"大陸シード({seed_lon},{seed_lat})が陸地に接続しません")

    major = {
        "Americas + Greenland": seed_label(-100, 40),
        "Europe + Scandinavia": seed_label(10, 50),
        "Africa + Madagascar": seed_label(20, 0),
        "Asia": seed_label(100, 40),
        "Oceania": seed_label(135, -25),
    }
    if len(set(major.values())) != len(major):
        raise RuntimeError(f"大陸分割回廊が不十分です: {major}")
    masks = {name: labels == label for name, label in major.items()}
    assigned_labels = set(major.values())
    for label in range(1, count + 1):
        if label in assigned_labels:
            continue
        component = labels == label
        ys, xs = np.where(component)
        if not xs.size:
            continue
        center_lon = float(lon[ys, xs].mean())
        center_lat = float(lat[ys, xs].mean())
        if center_lon < -25:
            target = "Americas + Greenland"
        elif center_lon >= 105 and center_lat < -10:
            target = "Oceania"
        elif center_lat < 35 and center_lon < 55 and not (center_lon > 36 and center_lat > 12):
            target = "Africa + Madagascar"
        elif center_lon < 60 and center_lat >= 30:
            target = "Europe + Scandinavia"
        else:
            target = "Asia"
        masks[target] |= component
    return masks


def contract_high_latitudes(codes: np.ndarray, mask: np.ndarray, lat_grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    result = codes.copy()
    result_mask = mask.copy()
    height, width = mask.shape
    all_xs = np.where(mask)[1]
    anchor = float(np.median(all_xs)) if all_xs.size else width / 2
    for y in range(height):
        latitude = float(lat_grid[y, 0])
        if latitude <= 60:
            continue
        row = mask[y]
        xs = np.where(row)[0]
        if not xs.size:
            continue
        result_mask[y, row] = False
        factor = max(0.55, 1.0 - (latitude - 60) / 30 * 0.45)
        targets = np.rint(anchor + (xs - anchor) * factor).astype(int)
        targets = np.clip(targets, 0, width - 1)
        for source_x, target_x in zip(xs, targets):
            result[y, target_x] = codes[y, source_x]
            result_mask[y, target_x] = True
    return result, result_mask


def region_bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask)
    if not xs.size:
        raise RuntimeError("空の大陸レイヤーです")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def resize_region(
    codes: np.ndarray,
    mask: np.ndarray,
    size: tuple[int, int],
) -> tuple[np.ndarray, np.ndarray, int, int]:
    x0, y0, x1, y1 = region_bbox(mask)
    crop_codes = codes[y0:y1, x0:x1]
    crop_mask = mask[y0:y1, x0:x1]
    source_components, source_count = ndimage.label(crop_mask, structure=LAND_STRUCTURE)
    code_image = image_from_code_array(crop_codes).resize(size, Image.Resampling.NEAREST)
    mask_image = Image.fromarray((crop_mask * 255).astype(np.uint8)).resize(size, Image.Resampling.NEAREST)
    resized_codes = read_codes_from_image(code_image)
    resized_mask = np.array(mask_image) > 0

    preserved = 0
    for component in range(1, source_count + 1):
        ys, xs = np.where(source_components == component)
        if not xs.size:
            continue
        source_x = int(round(float(xs.mean())))
        source_y = int(round(float(ys.mean())))
        target_x = min(size[0] - 1, max(0, int(round(source_x / max(1, crop_mask.shape[1] - 1) * (size[0] - 1)))))
        target_y = min(size[1] - 1, max(0, int(round(source_y / max(1, crop_mask.shape[0] - 1) * (size[1] - 1)))))
        y_start, y_end = max(0, target_y - 1), min(size[1], target_y + 2)
        x_start, x_end = max(0, target_x - 1), min(size[0], target_x + 2)
        if not resized_mask[y_start:y_end, x_start:x_end].any():
            resized_mask[target_y, target_x] = True
            resized_codes[target_y, target_x] = crop_codes[source_y, source_x]
            preserved += 1
    preserved_biomes = 0
    for code in np.unique(crop_codes[crop_mask]):
        if np.any(resized_mask & (resized_codes == code)):
            continue
        ys, xs = np.where(crop_mask & (crop_codes == code))
        source_x = int(round(float(xs.mean())))
        source_y = int(round(float(ys.mean())))
        target_x = min(size[0] - 1, max(0, int(round(source_x / max(1, crop_mask.shape[1] - 1) * (size[0] - 1)))))
        target_y = min(size[1] - 1, max(0, int(round(source_y / max(1, crop_mask.shape[0] - 1) * (size[1] - 1)))))
        resized_mask[target_y, target_x] = True
        resized_codes[target_y, target_x] = code
        preserved_biomes += 1
    return resized_codes, resized_mask, preserved, preserved_biomes


def read_codes_from_image(image: Image.Image) -> np.ndarray:
    pixels = np.array(image.convert("RGB"))
    result = np.full(pixels.shape[:2], "???", dtype="<U3")
    for code, color in RGB.items():
        result[np.all(pixels == color, axis=2)] = code
    if np.any(result == "???"):
        raise RuntimeError("リサイズ後にパレット外色が発生しました")
    return result


def paste_region(
    canvas: np.ndarray,
    occupied: np.ndarray,
    codes: np.ndarray,
    mask: np.ndarray,
    position: tuple[int, int],
    name: str,
) -> int:
    x, y = position
    height, width = mask.shape
    target = canvas[y : y + height, x : x + width]
    target_occupied = occupied[y : y + height, x : x + width]
    collision = mask & target_occupied
    if collision.any():
        raise RuntimeError(f"{name}が既存レイヤーと{int(collision.sum())}px衝突しました")
    target[mask] = codes[mask]
    target_occupied[mask] = True
    return int(mask.sum())


def add_new_continent(canvas: np.ndarray, occupied: np.ndarray, center: tuple[int, int]) -> np.ndarray:
    cx, cy = center
    points = [
        (-96, -58), (-76, -84), (-45, -78), (-12, -94), (20, -73), (61, -82),
        (101, -52), (91, -19), (119, 11), (101, 45), (67, 57), (39, 86),
        (4, 75), (-24, 94), (-51, 68), (-82, 76), (-98, 42), (-90, 12),
        (-105, -17), (-96, -39),
    ]
    mask_image = Image.new("L", (canvas.shape[1], canvas.shape[0]), 0)
    draw = ImageDraw.Draw(mask_image)
    draw.polygon([(cx + x, cy + y) for x, y in points], fill=255)
    mask = np.array(mask_image) > 0
    rng = np.random.default_rng(20260719)
    noise = ndimage.gaussian_filter(rng.random(mask.shape), sigma=(3.0, 5.0), mode="reflect")
    edge = mask ^ ndimage.binary_erosion(mask, iterations=5)
    mask[edge & (noise < np.quantile(noise[edge], 0.38))] = False
    mask = ndimage.binary_closing(mask, structure=LAND_STRUCTURE, iterations=1)
    collision = mask & occupied
    if collision.any():
        raise RuntimeError(f"新大陸が既存の島・大陸と{int(collision.sum())}px衝突しました")
    canvas[mask] = "PLN"
    occupied[mask] = True
    canvas[cy, cx] = "TWN"
    return mask


def add_ocean_depths(codes: np.ndarray, occupied: np.ndarray) -> None:
    water = ~occupied
    distance = ndimage.distance_transform_edt(water)
    shelf = water & (distance <= 2.2)
    ocean = water & (distance > 2.2) & (distance <= 7.5)
    codes[water] = "DPO"
    codes[ocean] = "OCN"
    codes[shelf] = "SHF"


def centered_trim(codes: np.ndarray, occupied: np.ndarray, center: tuple[int, int], margin: int = 12) -> np.ndarray:
    ys, xs = np.where(occupied)
    x0, x1 = max(0, int(xs.min()) - margin), min(codes.shape[1], int(xs.max()) + margin + 1)
    y0, y1 = max(0, int(ys.min()) - margin), min(codes.shape[0], int(ys.max()) + margin + 1)
    result = codes[y0:y1, x0:x1].copy()
    result[result == "TWN"] = "PLN"
    if result[result.shape[0] // 2, result.shape[1] // 2] != "PLN":
        raise RuntimeError("独立トリミング後の中心が新大陸の平原から外れました")
    result[result.shape[0] // 2, result.shape[1] // 2] = "TWN"
    return result


def resize_codes(codes: np.ndarray, max_width: int) -> np.ndarray:
    scale = min(1.0, max_width / codes.shape[1])
    width = max(1, int(round(codes.shape[1] * scale)))
    height = max(1, int(round(codes.shape[0] * scale)))
    resized = read_codes_from_image(image_from_code_array(codes).resize((width, height), Image.Resampling.NEAREST))
    resized = sanitize_resized_beaches(resized)
    for code in np.unique(codes):
        if code == "TWN" or np.any(resized == code):
            continue
        ys, xs = np.where(codes == code)
        source_x = float(xs.mean())
        source_y = float(ys.mean())
        target_x = min(width - 1, max(0, int(round(source_x / max(1, codes.shape[1] - 1) * (width - 1)))))
        target_y = min(height - 1, max(0, int(round(source_y / max(1, codes.shape[0] - 1) * (height - 1)))))
        resized[target_y, target_x] = code
    resized[height // 2, width // 2] = "TWN"
    return resized


def write_audit(
    path: Path,
    source_hash_before: str,
    source_hash_after: str,
    result: np.ndarray,
    map_maker: np.ndarray,
    preserved_components: int,
    preserved_biomes: int,
    layers: dict[str, int],
) -> None:
    center = str(result[result.shape[0] // 2, result.shape[1] // 2])
    unknown = sorted(set(np.unique(result)) - set(BIOMES))
    counts = Counter(result.ravel())
    lines = [
        "# オリジナル世界地図・変形監査",
        "",
        f"- 元画像SHA-256保持: {'合格' if source_hash_before == source_hash_after else '失敗'}",
        f"- 出力サイズ: {result.shape[1]}×{result.shape[0]}",
        f"- Map Makerサイズ: {map_maker.shape[1]}×{map_maker.shape[0]}",
        f"- 完全中心バイオーム: `{center}` ({'合格' if center == 'TWN' else '失敗'})",
        f"- パレット外コード: {len(unknown)}",
        f"- 縮小時に救済した微小島: {preserved_components}",
        f"- 縮小時に救済した希少バイオーム: {preserved_biomes}",
        f"- 新大陸平原: {counts['PLN']}px（中心のTWNを除く）",
        "",
        "## 移動レイヤー",
        "",
        "|layer|land pixels|",
        "|---|---:|",
    ]
    lines.extend(f"|{name}|{pixels}|" for name, pixels in layers.items())
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def generate(max_json_width: int) -> dict[str, Path]:
    source_hash = file_hash(SOURCE_IMAGE)
    source = read_codes(SOURCE_IMAGE)
    height, width = source.shape
    land = ~np.isin(source, list(WATER))
    lon, lat = lon_lat_grids(width, height)
    antarctica = land & (lat < -60)
    main_land = land & ~antarctica

    masks = split_macro_regions(main_land, lon, lat)
    masks["Antarctica"] = antarctica

    normalized = source.copy()
    for name in ("Americas + Greenland", "Europe + Scandinavia", "Asia"):
        normalized, masks[name] = contract_high_latitudes(normalized, masks[name], lat)

    canvas = np.full((720, 1120), "DPO", dtype="<U3")
    occupied = np.zeros(canvas.shape, dtype=bool)
    center = (canvas.shape[1] // 2, canvas.shape[0] // 2)
    layout = {
        "Americas + Greenland": ((15, 70), (280, 430)),
        "Europe + Scandinavia": ((365, 35), (255, 185)),
        "Africa + Madagascar": ((285, 330), (155, 260)),
        "Asia": ((690, 60), (360, 315)),
        "Oceania": ((810, 385), (260, 185)),
        "Antarctica": ((330, 615), (460, 78)),
    }
    preserved_components = 0
    preserved_biomes = 0
    layer_pixels: dict[str, int] = {}
    for name, (position, size) in layout.items():
        region_codes, region_mask, preserved, biome_rescues = resize_region(normalized, masks[name], size)
        preserved_components += preserved
        preserved_biomes += biome_rescues
        layer_pixels[name] = paste_region(canvas, occupied, region_codes, region_mask, position, name)

    new_continent = add_new_continent(canvas, occupied, center)
    layer_pixels["New central continent"] = int(new_continent.sum())
    add_ocean_depths(canvas, occupied)
    canvas[center[1], center[0]] = "TWN"
    result = centered_trim(canvas, occupied, center)
    map_maker = resize_codes(result, max_json_width)

    image_path = OUTPUT / f"fantasy_biome_world_{result.shape[1]}x{result.shape[0]}.png"
    json_image_path = OUTPUT / f"fantasy_biome_world_{map_maker.shape[1]}x{map_maker.shape[0]}.png"
    json_path = OUTPUT / f"fantasy_biome_world_{map_maker.shape[1]}x{map_maker.shape[0]}.json"
    audit_path = OUTPUT / "fantasy_biome_world_layout_audit.md"
    image_from_code_array(result).save(image_path)
    image_from_code_array(map_maker).save(json_image_path)
    write_json(map_maker, json_path)
    write_audit(
        audit_path,
        source_hash,
        file_hash(SOURCE_IMAGE),
        result,
        map_maker,
        preserved_components,
        preserved_biomes,
        layer_pixels,
    )
    return {"image": image_path, "json_image": json_image_path, "json": json_path, "audit": audit_path}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-width", type=int, default=512)
    args = parser.parse_args()
    for name, path in generate(args.json_width).items():
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()
