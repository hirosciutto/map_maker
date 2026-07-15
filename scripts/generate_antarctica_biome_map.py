#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import urllib.request
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFont
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import transform
from scipy import ndimage

from generate_geo_biome_world import BIOMES, RGB


DATA_DIR = Path("/tmp/blockland_geo/bedmap3")
OUTPUT_DIR = Path("/Users/nakashima/works/map_maker/output")
BEDMAP3_ENTRY = "2d0e4791-8e20-46a3-80e4-f5f6716025d2"
SURFACE_PATH = DATA_DIR / "bm3_surface.tif"
MASK_PATH = DATA_DIR / "bm3_masks.tif"
SURFACE_URL = (
    "https://ramadda.data.bas.ac.uk/repository/entry/get/bm3_surface.tif?"
    f"entryid=synth:{BEDMAP3_ENTRY}:L2JtM19zdXJmYWNlLnRpZg=="
)
MASK_URL = (
    "https://ramadda.data.bas.ac.uk/repository/entry/get/bm3_masks.tif?"
    f"entryid=synth:{BEDMAP3_ENTRY}:L2JtM19tYXNrcy50aWY="
)
BEDMAP3_CITATION = (
    "Pritchard et al. (2024), BEDMAP3 v1.0, NERC EDS UK Polar Data Centre, "
    "https://doi.org/10.5285/2d0e4791-8e20-46a3-80e4-f5f6716025d2"
)

ICE_CODES = {"ICE", "IFD", "GLC", "IDM", "HGL", "SNM"}
LAND_CODES = ICE_CODES | {"PLR", "TND", "MTN", "ARK", "HRK", "HMT"}
WATER_CODES = {"SHF", "OCN", "DPO"}
ALLOWED_CODES = LAND_CODES | WATER_CODES


def download(url: str, destination: Path) -> None:
    if destination.exists() and destination.stat().st_size > 300_000_000:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    with urllib.request.urlopen(url) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    temporary.replace(destination)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def aggregate_source(size: int, oversample: int = 4) -> dict[str, np.ndarray | float]:
    high_size = size * oversample
    with rasterio.open(SURFACE_PATH) as surface_source:
        surface_high = surface_source.read(
            1,
            out_shape=(high_size, high_size),
            resampling=Resampling.average,
        ).astype(np.float32)
        bounds = surface_source.bounds
        source_crs = surface_source.crs
    with rasterio.open(MASK_PATH) as mask_source:
        mask_high = mask_source.read(
            1,
            out_shape=(high_size, high_size),
            resampling=Resampling.nearest,
        )

    surface_blocks = surface_high.reshape(size, oversample, size, oversample)
    valid_blocks = surface_blocks > -9000
    valid_count = valid_blocks.sum(axis=(1, 3))
    surface_mean = np.where(valid_blocks, surface_blocks, 0).sum(axis=(1, 3))
    surface_mean /= np.maximum(valid_count, 1)
    surface_max = np.where(valid_blocks, surface_blocks, -1e9).max(axis=(1, 3))

    mask_blocks = mask_high.reshape(size, oversample, size, oversample)
    fractions = {
        value: (mask_blocks == value).mean(axis=(1, 3))
        for value in (1, 2, 3, 4)
    }
    nonsea_fraction = sum(fractions.values())
    nonsea = nonsea_fraction >= 0.08
    dominant = np.stack([fractions[value] for value in (1, 2, 3, 4)]).argmax(axis=0) + 1
    dominant[~nonsea] = 0

    nearest = ndimage.distance_transform_edt(
        ~nonsea,
        return_distances=False,
        return_indices=True,
    )
    filled_surface = surface_mean[tuple(nearest)]
    local_relief = (
        ndimage.maximum_filter(filled_surface, size=5, mode="nearest")
        - ndimage.minimum_filter(filled_surface, size=5, mode="nearest")
    )
    local_relief[~nonsea] = 0

    output_transform = from_bounds(*bounds, size, size)
    x = output_transform.c + (np.arange(size) + 0.5) * output_transform.a
    y = output_transform.f + (np.arange(size) + 0.5) * output_transform.e
    xx, yy = np.meshgrid(x, y)
    longitude_values, latitude_values = transform(
        source_crs,
        "EPSG:4326",
        xx.ravel().tolist(),
        yy.ravel().tolist(),
    )
    longitude = np.asarray(longitude_values).reshape(size, size)
    latitude = np.asarray(latitude_values).reshape(size, size)
    cell_km = abs(output_transform.a) / 1000

    return {
        "surface_mean": surface_mean,
        "surface_max": surface_max,
        "local_relief": local_relief,
        "fractions": fractions,
        "dominant": dominant,
        "nonsea": nonsea,
        "longitude": longitude,
        "latitude": latitude,
        "cell_km": cell_km,
    }


def highest_cell(
    surface_max: np.ndarray,
    eligible: np.ndarray,
    longitude: np.ndarray,
    latitude: np.ndarray,
    lon_min: float,
    lon_max: float,
    lat_min: float,
    lat_max: float,
) -> tuple[int, int] | None:
    region = eligible & (latitude >= lat_min) & (latitude <= lat_max)
    if lon_min <= lon_max:
        region &= (longitude >= lon_min) & (longitude <= lon_max)
    else:
        region &= (longitude >= lon_min) | (longitude <= lon_max)
    if not region.any():
        return None
    values = np.where(region, surface_max, -1e9)
    index = int(values.argmax())
    return np.unravel_index(index, values.shape)


def classify(size: int) -> tuple[np.ndarray, dict[str, np.ndarray | float]]:
    source = aggregate_source(size)
    surface = source["surface_mean"]
    surface_max = source["surface_max"]
    relief = source["local_relief"]
    fractions = source["fractions"]
    dominant = source["dominant"]
    nonsea = source["nonsea"]
    longitude = source["longitude"]
    latitude = source["latitude"]

    codes = np.full((size, size), "OCN", dtype="<U3")
    ocean_distance = ndimage.distance_transform_edt(~nonsea)
    codes[(~nonsea) & (ocean_distance <= 2)] = "SHF"

    rock_candidates = nonsea & (fractions[4] > 0)
    rock_target_cells = min(int(round(float(fractions[4].sum()))), int(rock_candidates.sum()))
    y_index, x_index = np.indices(codes.shape)
    tie_breaker = ((x_index * 73856093) ^ (y_index * 19349663)) % 104729
    rock_score = fractions[4] + tie_breaker / 104729 * 1e-5
    rock = np.zeros_like(nonsea)
    if rock_target_cells:
        candidate_indices = np.flatnonzero(rock_candidates)
        selected = candidate_indices[
            np.argpartition(rock_score.ravel()[candidate_indices], -rock_target_cells)[-rock_target_cells:]
        ]
        rock.ravel()[selected] = True

    floating = nonsea & ((dominant == 2) | (dominant == 3)) & ~rock
    grounded = nonsea & ~floating & ~rock
    grounded &= ~rock

    codes[floating] = "ICE"
    codes[grounded & (surface < 850)] = "ICE"
    codes[grounded & (surface >= 850) & (surface < 2350)] = "IFD"
    codes[grounded & (surface >= 2350)] = "IDM"

    rugged_glacier = grounded & (relief >= 450) & (surface >= 1300) & (surface < 2850)
    snowy_mountain = grounded & (relief >= 600) & (surface >= 2850) & (surface < 3900)
    high_glacier = grounded & (relief >= 500) & (surface_max >= 4200)
    codes[rugged_glacier] = "GLC"
    codes[snowy_mountain] = "SNM"
    codes[high_glacier] = "HGL"

    maritime_tundra = rock & (latitude >= -68.5) & (surface < 600)
    codes[rock] = "PLR"
    codes[maritime_tundra] = "TND"
    codes[rock & (surface_max >= 1200) & (surface_max < 2400)] = "MTN"
    codes[rock & (surface_max >= 2400) & (surface_max < 3200)] = "ARK"
    codes[rock & (surface_max >= 3200) & (surface_max < 4400)] = "HRK"

    vinson = highest_cell(
        surface_max,
        nonsea,
        longitude,
        latitude,
        -92,
        -78,
        -80.5,
        -77,
    )
    if vinson is not None and surface_max[vinson] >= 4400:
        codes[vinson] = "HMT"

    if not np.any(codes == "HGL"):
        rescue = grounded & (surface_max >= 4000) & (relief >= 400)
        if vinson is not None:
            rescue[vinson] = False
        if rescue.any():
            rescue_index = int(np.where(rescue, surface_max, -1e9).argmax())
            codes[np.unravel_index(rescue_index, codes.shape)] = "HGL"

    if not np.all(np.isin(codes, list(ALLOWED_CODES))):
        unknown = sorted(set(codes.ravel()) - ALLOWED_CODES)
        raise RuntimeError(f"南極マップに未許可コードがあります: {unknown}")
    source["vinson"] = vinson
    source["rock_target_cells"] = rock_target_cells
    source["rock_selected_cells"] = int(rock.sum())
    return codes, source


def image_from_codes(codes: np.ndarray) -> Image.Image:
    array = np.zeros((codes.shape[0], codes.shape[1], 3), dtype=np.uint8)
    for code in np.unique(codes):
        array[codes == code] = RGB[code]
    return Image.fromarray(array, "RGB")


def write_json(codes: np.ndarray, path: Path) -> None:
    width = int(codes.shape[1])
    height = int(codes.shape[0])
    data = {
        "width": width,
        "height": height,
        "size": width,
        "seed": None,
        "scheme": "map-maker-v2",
        "layer": "public",
        "source": "BEDMAP3 surface elevation and masks / Antarctica biome generator",
        "px_means": "1px = 1 region",
        "region_blocks": 64,
        "world_width_blocks": width * 64,
        "world_height_blocks": height * 64,
        "legend": BIOMES,
        "rows": ["".join(row) for row in codes],
        "structures": [],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_fonts() -> tuple[ImageFont.ImageFont, ImageFont.ImageFont, ImageFont.ImageFont]:
    try:
        return (
            ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", 26),
            ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", 15),
            ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", 12),
        )
    except OSError:
        default = ImageFont.load_default()
        return default, default, default


def compose_panel(image: Image.Image, codes: np.ndarray, source: dict[str, np.ndarray | float]) -> Image.Image:
    counts = Counter(codes.ravel())
    used = sorted(counts, key=lambda code: (BIOMES[code]["elevation"], code))
    columns = 3
    rows = math.ceil(len(used) / columns)
    panel_height = 92 + rows * 28
    panel = Image.new("RGB", (image.width, image.height + panel_height), (246, 248, 250))
    panel.paste(image, (0, 0))
    draw = ImageDraw.Draw(panel)
    title_font, font, small = load_fonts()
    y0 = image.height
    draw.rectangle((0, y0, image.width, y0 + panel_height), fill=(246, 248, 250))
    draw.text((18, y0 + 12), "南極バイオーム図（BEDMAP3表面標高準拠）", fill=(18, 22, 28), font=title_font)
    draw.text(
        (18, y0 + 48),
        "極投影 / 沿岸氷床→氷原→内陸氷冠高原、起伏セルのみ山岳氷河・雪山へ昇格",
        fill=(58, 64, 72),
        font=small,
    )
    total = codes.size
    column_width = image.width // columns
    for index, code in enumerate(used):
        column = index // rows
        row = index % rows
        x = 18 + column * column_width
        y = y0 + 76 + row * 28
        draw.rectangle((x, y, x + 20, y + 16), fill=RGB[code], outline=(60, 64, 68))
        draw.text(
            (x + 28, y - 2),
            f"{code} {BIOMES[code]['jp']} {counts[code] / total * 100:.1f}% / {BIOMES[code]['elevation']}m",
            fill=(28, 32, 38),
            font=font,
        )
    return panel


def validate_palette(image: Image.Image, codes: np.ndarray) -> None:
    allowed_rgb = {RGB[code] for code in ALLOWED_CODES}
    actual_rgb = set(map(tuple, np.asarray(image).reshape(-1, 3)))
    unknown_colors = actual_rgb - allowed_rgb
    if unknown_colors:
        raise RuntimeError(f"パレット外色があります: {sorted(unknown_colors)[:10]}")
    if set(codes.ravel()) - ALLOWED_CODES:
        raise RuntimeError("未許可バイオームコードがあります")
    forbidden_high = {"PSN", "XPK", "HIM"} & set(codes.ravel())
    if forbidden_high:
        raise RuntimeError(f"南極最高標高を超えるバイオームがあります: {sorted(forbidden_high)}")


def write_audit(
    path: Path,
    codes: np.ndarray,
    source: dict[str, np.ndarray | float],
    resized_codes: np.ndarray,
) -> None:
    surface = source["surface_mean"]
    nonsea = source["nonsea"]
    fractions = source["fractions"]
    cell_km = float(source["cell_km"])
    cell_area = cell_km * cell_km
    counts = Counter(codes.ravel())
    nonsea_count = int(nonsea.sum())
    rock_fraction = float(fractions[4].sum() / max(sum(value.sum() for value in fractions.values()), 1))
    lines = [
        "# Antarctica Biome Audit",
        "",
        f"- source: {BEDMAP3_CITATION}",
        f"- source surface SHA-256: `{sha256(SURFACE_PATH)}`",
        f"- source mask SHA-256: `{sha256(MASK_PATH)}`",
        f"- polar projection: EPSG:3031",
        f"- output size: {codes.shape[1]}x{codes.shape[0]}",
        f"- represented cell size: {cell_km:.2f} km ({cell_area:.1f} km²)",
        f"- non-sea cells: {nonsea_count}",
        f"- source rock share: {rock_fraction * 100:.3f}%",
        f"- target rock-equivalent cells: {int(source['rock_target_cells'])}",
        f"- represented rock-biome cells: {int(source['rock_selected_cells'])}",
        f"- maximum aggregated surface elevation: {float(source['surface_max'][nonsea].max()):.0f} m",
        "- ICE/IFD/IDM: 標高アンカー500/1200/3500mの中間値850/2350mで区分",
        "- GLC: 1300–2850mかつ43km窓起伏450m以上",
        "- SNM: 2850–3900mかつ43km窓起伏600m以上",
        "- HGL: セル内最高標高4200m以上かつ43km窓起伏500m以上",
        "- HMT: ヴィンソン山塊範囲内の最高適格1セルのみ（4400m以上）",
        "- PSN/XPK/HIM: 南極最高峰4892mが各アンカー5500/6800/8500m未満のため不使用",
        "- floating ice shelves: ICE",
        "- rock outcrops / Dry Valleys: PLR、標高に応じてMTN→ARK→HRK",
        "",
        "| code | biome | anchor m | pixels | map % | land/ice % | median BEDMAP3 m | max BEDMAP3 m |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for code in sorted(counts, key=lambda item: (BIOMES[item]["elevation"], item)):
        mask = codes == code
        land_mask = mask & nonsea
        median = "—"
        maximum = "—"
        if land_mask.any():
            median = str(int(round(float(np.median(surface[land_mask])))))
            maximum = str(int(round(float(source["surface_max"][land_mask].max()))))
        land_pct = land_mask.sum() / nonsea_count * 100 if nonsea_count else 0
        lines.append(
            f"| `{code}` | {BIOMES[code]['jp']} | {BIOMES[code]['elevation']} | {counts[code]} | "
            f"{counts[code] / codes.size * 100:.3f}% | {land_pct:.3f}% | {median} | {maximum} |"
        )
    lines.extend(
        [
            "",
            "## Validation",
            "",
            f"- high-resolution unknown codes: {len(set(codes.ravel()) - ALLOWED_CODES)}",
            f"- 512px unknown codes: {len(set(resized_codes.ravel()) - ALLOWED_CODES)}",
            f"- high-resolution used biomes: {', '.join(sorted(set(codes.ravel())))}",
            f"- 512px used biomes: {', '.join(sorted(set(resized_codes.ravel())))}",
            "- palette-only PNG: pass",
            "- source world-map outputs modified: no",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def generate(size: int, json_size: int) -> dict[str, Path]:
    download(SURFACE_URL, SURFACE_PATH)
    download(MASK_URL, MASK_PATH)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    codes, source = classify(size)
    image = image_from_codes(codes)
    validate_palette(image, codes)

    resized_codes, _ = classify(json_size)
    resized_image = image_from_codes(resized_codes)
    validate_palette(resized_image, resized_codes)

    base = f"antarctica_biome_bedmap3_{size}x{size}"
    image_path = OUTPUT_DIR / f"{base}.png"
    panel_path = OUTPUT_DIR / f"{base}_panel.png"
    audit_path = OUTPUT_DIR / f"{base}_audit.md"
    json_base = f"antarctica_biome_bedmap3_{json_size}x{json_size}"
    json_png_path = OUTPUT_DIR / f"{json_base}.png"
    json_path = OUTPUT_DIR / f"{json_base}.json"

    image.save(image_path)
    compose_panel(image, codes, source).save(panel_path)
    resized_image.save(json_png_path)
    write_json(resized_codes, json_path)
    write_audit(audit_path, codes, source, resized_codes)
    return {
        "image": image_path,
        "panel": panel_path,
        "json_png": json_png_path,
        "json": json_path,
        "audit": audit_path,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate an elevation-aware Antarctica biome map")
    parser.add_argument("--size", type=int, default=768)
    parser.add_argument("--json-size", type=int, default=512)
    args = parser.parse_args()
    outputs = generate(args.size, args.json_size)
    for name, path in outputs.items():
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()
