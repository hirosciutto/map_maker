#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import urllib.parse
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
import shapefile
from PIL import Image, ImageDraw, ImageFont
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.warp import transform, transform_geom
from scipy import ndimage

from generate_geo_biome_world import BIOMES, RGB, longest_exact_transition, naturalize_raster_steps


DATA_DIR = Path("/tmp/blockland_geo/arctic_region")
OUTPUT_DIR = Path("/Users/nakashima/works/map_maker/output")
SOURCE_SIZE = 1536
SOURCE_BBOX = (-2_300_000, -3_400_000, 1_500_000, 400_000)
ARCTICDEM_PATH = DATA_DIR / "arcticdem_greenland_baffin_1536x1536.tif"
ECOREGIONS_PATH = DATA_DIR / "ecoregions_target.geojson"
ARCTICDEM_SERVICE = (
    "https://overlord.pgc.umn.edu/arcgis/rest/services/elevation/"
    "pgc_arcticdem_mosaics_latest/ImageServer/exportImage"
)
ECOREGION_QUERY = (
    "https://data-gis.unep-wcmc.org/server/rest/services/Bio-geographicalRegions/"
    "Resolve_Ecoregions/FeatureServer/0/query?"
    "where=objectid%20in%20%28837%2C96%2C359%2C311%2C439%2C748%2C201%2C207%2C228%2C510%2C135%29"
    "&outFields=OBJECTID%2CECO_NAME%2CBIOME_NUM%2CBIOME_NAME&returnGeometry=true"
    "&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.01&f=geojson"
)
ARCTICDEM_CITATION = (
    "Porter et al. (2023), ArcticDEM Mosaic v4.1, "
    "https://doi.org/10.7910/DVN/3VDC4W"
)
ECOREGION_CITATION = (
    "RESOLVE Ecoregions 2017, CC-BY-4.0, "
    "https://developers.google.com/earth-engine/datasets/catalog/RESOLVE_ECOREGIONS_2017"
)

NATURAL_EARTH = {
    "land": "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_land.zip",
    "glaciated_areas": "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_glaciated_areas.zip",
    "lakes": "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_lakes.zip",
}

LAND_CODES = {
    "TND", "PLR", "TGA", "CTG", "ICE", "IFD", "GLC", "IDM", "SNM",
    "MTN", "ARK", "HRK", "ALT",
}
WATER_CODES = {"OCN", "SHF"}
ALLOWED_CODES = LAND_CODES | WATER_CODES
FORBIDDEN_HEIGHT_CODES = {"HGL", "HMT", "PSN", "XPK", "HIM"}
GLACIER_CODES = {"ICE", "IFD", "GLC", "IDM", "SNM"}


def run_curl(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["curl", "-k", "-L", "--fail", "--retry", "3", "-sS", "-o", str(destination), url],
        check=True,
    )


def ensure_arcticdem() -> None:
    if ARCTICDEM_PATH.exists() and ARCTICDEM_PATH.stat().st_size > 1_000_000:
        return
    parameters = {
        "bbox": ",".join(str(value) for value in SOURCE_BBOX),
        "bboxSR": "3413",
        "imageSR": "3413",
        "size": f"{SOURCE_SIZE},{SOURCE_SIZE}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "json",
    }
    metadata_path = DATA_DIR / "arcticdem_export.json"
    run_curl(f"{ARCTICDEM_SERVICE}?{urllib.parse.urlencode(parameters)}", metadata_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    run_curl(metadata["href"], ARCTICDEM_PATH)


def ensure_natural_earth() -> None:
    for name, url in NATURAL_EARTH.items():
        directory = DATA_DIR / name
        shapefile_path = directory / f"ne_10m_{name}.shp"
        if shapefile_path.exists():
            continue
        archive = DATA_DIR / f"{name}.zip"
        archive.parent.mkdir(parents=True, exist_ok=True)
        run_curl(url, archive)
        directory.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as zipped:
            zipped.extractall(directory)


def ensure_ecoregions() -> None:
    if ECOREGIONS_PATH.exists() and ECOREGIONS_PATH.stat().st_size > 100_000:
        return
    run_curl(ECOREGION_QUERY, ECOREGIONS_PATH)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def target_shapes(path: Path, target_crs: rasterio.crs.CRS) -> list[dict]:
    output: list[dict] = []
    for shape in shapefile.Reader(str(path)).shapes():
        minimum_x, minimum_y, maximum_x, maximum_y = shape.bbox
        if maximum_x < -115 or minimum_x > 20 or maximum_y < 50:
            continue
        output.append(
            transform_geom(
                "EPSG:4326",
                target_crs,
                shape.__geo_interface__,
                antimeridian_cutting=True,
                precision=1,
            )
        )
    return output


def rasterize_shapes(shapes: list[dict], output_shape: tuple[int, int], transform_value) -> np.ndarray:
    return rasterize(
        ((geometry, 1) for geometry in shapes),
        out_shape=output_shape,
        transform=transform_value,
        fill=0,
        all_touched=False,
        dtype="uint8",
    ).astype(bool)


def rasterize_ecoregions(output_shape: tuple[int, int], transform_value, target_crs) -> np.ndarray:
    data = json.loads(ECOREGIONS_PATH.read_text(encoding="utf-8"))
    shapes: list[tuple[dict, int]] = []
    for feature in data["features"]:
        name = feature["properties"]["eco_name"]
        biome_number = int(feature["properties"].get("biome_num") or 0)
        if name == "Rock and Ice":
            continue
        if "High Arctic" in name:
            value = 1
        elif biome_number == 6:
            value = 3
        else:
            value = 2
        geometry = transform_geom(
            "EPSG:4326",
            target_crs,
            feature["geometry"],
            antimeridian_cutting=True,
            precision=1,
        )
        shapes.append((geometry, value))
    return rasterize(
        shapes,
        out_shape=output_shape,
        transform=transform_value,
        fill=0,
        all_touched=False,
        dtype="uint8",
    )


def select_fraction_area(fraction: np.ndarray, eligible: np.ndarray | None = None) -> np.ndarray:
    candidates = fraction > 0
    if eligible is not None:
        candidates &= eligible
    target = min(int(round(float(fraction.sum()))), int(candidates.sum()))
    selected_mask = np.zeros_like(candidates)
    if target == 0:
        return selected_mask
    y_index, x_index = np.indices(fraction.shape)
    tie_breaker = ((x_index * 73856093) ^ (y_index * 19349663)) % 104729
    score = fraction + tie_breaker / 104729 * 1e-5
    candidate_indices = np.flatnonzero(candidates)
    selected = candidate_indices[np.argpartition(score.ravel()[candidate_indices], -target)[-target:]]
    selected_mask.ravel()[selected] = True
    return selected_mask


def aggregate_fraction(mask: np.ndarray, size: int) -> np.ndarray:
    factor = SOURCE_SIZE // size
    return mask.reshape(size, factor, size, factor).mean(axis=(1, 3))


def aggregate_mode(values: np.ndarray, size: int, classes: tuple[int, ...]) -> np.ndarray:
    factor = SOURCE_SIZE // size
    blocks = values.reshape(size, factor, size, factor)
    fractions = np.stack([(blocks == value).mean(axis=(1, 3)) for value in classes])
    return np.asarray(classes)[fractions.argmax(axis=0)]


def load_source() -> dict[str, np.ndarray | rasterio.Affine | rasterio.crs.CRS]:
    ensure_arcticdem()
    ensure_natural_earth()
    ensure_ecoregions()
    with rasterio.open(ARCTICDEM_PATH) as dataset:
        dem = dataset.read(1).astype(np.float32)
        transform_value = dataset.transform
        crs = dataset.crs
    shape = dem.shape
    land = rasterize_shapes(
        target_shapes(DATA_DIR / "land/ne_10m_land.shp", crs),
        shape,
        transform_value,
    )
    glacier = rasterize_shapes(
        target_shapes(DATA_DIR / "glaciated_areas/ne_10m_glaciated_areas.shp", crs),
        shape,
        transform_value,
    )
    lakes = rasterize_shapes(
        target_shapes(DATA_DIR / "lakes/ne_10m_lakes.shp", crs),
        shape,
        transform_value,
    )
    glacier &= land & ~lakes
    ecoregions = rasterize_ecoregions(shape, transform_value, crs)
    return {
        "dem": dem,
        "land": land,
        "glacier": glacier,
        "lakes": lakes,
        "ecoregions": ecoregions,
        "transform": transform_value,
        "crs": crs,
    }


def coordinate_grids(size: int) -> tuple[np.ndarray, np.ndarray, float]:
    minimum_x, minimum_y, maximum_x, maximum_y = SOURCE_BBOX
    cell_m = (maximum_x - minimum_x) / size
    x = minimum_x + (np.arange(size) + 0.5) * cell_m
    y = maximum_y - (np.arange(size) + 0.5) * cell_m
    xx, yy = np.meshgrid(x, y)
    longitude_values, latitude_values = transform(
        "EPSG:3413",
        "EPSG:4326",
        xx.ravel().tolist(),
        yy.ravel().tolist(),
    )
    return (
        np.asarray(longitude_values).reshape(size, size),
        np.asarray(latitude_values).reshape(size, size),
        cell_m / 1000,
    )


def classify(source: dict[str, np.ndarray | rasterio.Affine | rasterio.crs.CRS], size: int) -> tuple[np.ndarray, dict]:
    factor = SOURCE_SIZE // size
    dem_blocks = source["dem"].reshape(size, factor, size, factor)
    surface = dem_blocks.mean(axis=(1, 3))
    surface_max = dem_blocks.max(axis=(1, 3))
    land_fraction = aggregate_fraction(source["land"], size)
    lake_fraction = aggregate_fraction(source["lakes"], size)
    glacier_fraction = aggregate_fraction(source["glacier"], size)
    land = select_fraction_area(land_fraction)
    lakes = select_fraction_area(lake_fraction, land)
    land &= ~lakes
    glacier = select_fraction_area(glacier_fraction, land)
    ecoregion = aggregate_mode(source["ecoregions"], size, (0, 1, 2, 3))
    longitude, latitude, cell_km = coordinate_grids(size)

    nearest_land = ndimage.distance_transform_edt(
        ~land,
        return_distances=False,
        return_indices=True,
    )
    filled_surface = surface[tuple(nearest_land)]
    relief = (
        ndimage.maximum_filter(filled_surface, size=5, mode="nearest")
        - ndimage.minimum_filter(filled_surface, size=5, mode="nearest")
    )
    relief[~land] = 0

    codes = np.full((size, size), "OCN", dtype="<U3")
    ocean = ~land
    ocean_distance = ndimage.distance_transform_edt(ocean)
    codes[ocean & ~lakes & (ocean_distance <= 2)] = "SHF"
    codes[lakes] = "OCN"

    codes[glacier & (surface < 850)] = "ICE"
    codes[glacier & (surface >= 850) & (surface < 2350)] = "IFD"
    codes[glacier & (surface >= 2350)] = "IDM"
    rugged_glacier = glacier & (surface >= 900) & (surface < 2700) & (relief >= 300)
    snow_mountain = glacier & (surface >= 2700) & (relief >= 450)
    codes[rugged_glacier] = "GLC"
    codes[snow_mountain] = "SNM"

    bare = land & ~glacier
    codes[bare] = "TND"
    codes[bare & (ecoregion == 1)] = "PLR"
    codes[bare & (ecoregion == 2)] = "TND"
    codes[bare & (ecoregion == 3)] = "TGA"
    codes[bare & (ecoregion == 3) & ((surface >= 600) | (relief >= 300))] = "CTG"

    polar_bare = bare & np.isin(codes, ["TND", "PLR"])
    codes[polar_bare & (surface >= 2500) & (relief < 500)] = "ALT"
    codes[polar_bare & (surface >= 1200) & (relief >= 300)] = "MTN"
    codes[polar_bare & (surface_max >= 2400) & (surface >= 1800) & (relief >= 450)] = "ARK"
    codes[polar_bare & (surface_max >= 3300) & (surface >= 2400) & (relief >= 600)] = "HRK"

    codes[codes == "CTG"] = "TGA"
    original_codes = codes.copy()
    glacier_target = int(np.isin(original_codes, list(GLACIER_CODES)).sum())
    naturalize_raster_steps(codes, land, LAND_CODES, 20260715)
    represented_glacier = np.isin(codes, list(GLACIER_CODES))
    glacier_delta = glacier_target - int(represented_glacier.sum())
    if glacier_delta > 0:
        adjacent = ndimage.binary_dilation(represented_glacier, structure=np.ones((3, 3), dtype=bool))
        candidates = np.argwhere(~represented_glacier & land & glacier & adjacent)
        order = np.argsort(surface[candidates[:, 0], candidates[:, 1]])[::-1]
        for row, column in candidates[order[:glacier_delta]]:
            codes[row, column] = original_codes[row, column]
    elif glacier_delta < 0:
        adjacent = ndimage.binary_dilation(
            ~represented_glacier & land,
            structure=np.ones((3, 3), dtype=bool),
        )
        candidates = np.argwhere(represented_glacier & ~glacier & adjacent)
        order = np.argsort(surface[candidates[:, 0], candidates[:, 1]])
        for row, column in candidates[order[:-glacier_delta]]:
            codes[row, column] = original_codes[row, column]

    represented_glacier = np.isin(codes, list(GLACIER_CODES))

    if FORBIDDEN_HEIGHT_CODES & set(codes.ravel()):
        raise RuntimeError("地域最高標高を超えるバイオームが生成されました")
    if set(codes.ravel()) - ALLOWED_CODES:
        raise RuntimeError(f"未許可コードがあります: {sorted(set(codes.ravel()) - ALLOWED_CODES)}")

    report = {
        "surface": surface,
        "surface_max": surface_max,
        "relief": relief,
        "land": land,
        "glacier": represented_glacier,
        "lakes": lakes,
        "longitude": longitude,
        "latitude": latitude,
        "cell_km": cell_km,
        "land_target": int(round(float(land_fraction.sum()))) - int(lakes.sum()),
        "glacier_target": min(
            int(round(float(glacier_fraction.sum()))),
            int(((glacier_fraction > 0) & land).sum()),
        ),
    }
    return codes, report


def image_from_codes(codes: np.ndarray) -> Image.Image:
    array = np.zeros((codes.shape[0], codes.shape[1], 3), dtype=np.uint8)
    for code in np.unique(codes):
        array[codes == code] = RGB[code]
    return Image.fromarray(array, "RGB")


def load_fonts() -> tuple[ImageFont.ImageFont, ImageFont.ImageFont, ImageFont.ImageFont]:
    try:
        return (
            ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", 25),
            ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", 14),
            ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", 11),
        )
    except OSError:
        default = ImageFont.load_default()
        return default, default, default


def compose_panel(image: Image.Image, codes: np.ndarray) -> Image.Image:
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
    draw.text((18, y0 + 12), "グリーンランド・バフィン地域バイオーム図", fill=(18, 22, 28), font=title_font)
    draw.text(
        (18, y0 + 47),
        "ArcticDEM標高 + Natural Earth氷河/海岸 + RESOLVE高北極・中北極・タイガ境界",
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


def write_json(codes: np.ndarray, path: Path) -> None:
    size = int(codes.shape[0])
    data = {
        "width": size,
        "height": size,
        "size": size,
        "seed": None,
        "scheme": "map-maker-v2",
        "layer": "public",
        "source": "ArcticDEM + Natural Earth + RESOLVE / Greenland-Baffin generator",
        "px_means": "1px = 1 region",
        "region_blocks": 64,
        "world_width_blocks": size * 64,
        "world_height_blocks": size * 64,
        "legend": BIOMES,
        "rows": ["".join(row) for row in codes],
        "structures": [],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def validate(codes: np.ndarray, image: Image.Image, report: dict) -> None:
    actual_colors = set(map(tuple, np.asarray(image).reshape(-1, 3)))
    allowed_colors = {RGB[code] for code in ALLOWED_CODES}
    if actual_colors - allowed_colors:
        raise RuntimeError("パレット外色があります")
    if int(report["land"].sum()) != int(report["land_target"]):
        raise RuntimeError("陸地面積保存に失敗しました")
    if int(report["glacier"].sum()) != int(report["glacier_target"]):
        raise RuntimeError("氷河面積保存に失敗しました")
    max_run = max(3, int(round(codes.shape[1] / 256 * 3)))
    noncoastal = lambda first, second: first not in WATER_CODES and second not in WATER_CODES
    horizontal = longest_exact_transition(codes, True, noncoastal)
    vertical = longest_exact_transition(codes, False, noncoastal)
    if horizontal[0] > max_run or vertical[0] > max_run:
        raise RuntimeError(
            f"バイオーム境界が直線的です: horizontal={horizontal[0]} vertical={vertical[0]} limit={max_run}"
        )


def write_audit(path: Path, codes: np.ndarray, report: dict, resized_codes: np.ndarray, resized_report: dict) -> None:
    counts = Counter(codes.ravel())
    land = report["land"]
    surface = report["surface"]
    cell_km = float(report["cell_km"])
    noncoastal = lambda first, second: first not in WATER_CODES and second not in WATER_CODES
    horizontal = longest_exact_transition(codes, True, noncoastal)
    vertical = longest_exact_transition(codes, False, noncoastal)
    lines = [
        "# Greenland–Baffin Biome Audit",
        "",
        f"- elevation source: {ARCTICDEM_CITATION}",
        f"- ecoregion source: {ECOREGION_CITATION}",
        f"- ArcticDEM SHA-256: `{sha256(ARCTICDEM_PATH)}`",
        "- projection: EPSG:3413",
        f"- output size: {codes.shape[1]}x{codes.shape[0]}",
        f"- represented cell size: {cell_km:.2f} km ({cell_km * cell_km:.1f} km²)",
        f"- represented land cells: {int(land.sum())} / target {int(report['land_target'])}",
        f"- represented glacier cells: {int(report['glacier'].sum())} / target {int(report['glacier_target'])}",
        f"- maximum aggregated ArcticDEM elevation: {float(report['surface_max'][land].max()):.0f} m",
        "- ICE/IFD/IDM: 標高アンカー500/1200/3500mの中間値850/2350mで区分",
        "- GLC/SNM: 氷域かつDEM局地起伏を満たす不規則セルだけに限定",
        "- PLR/TND/TGA: 固定緯度線ではなくRESOLVE実エコリージョン境界を使用",
        "- HGL/HMT/PSN/XPK/HIM: 地域最高標高が各アンカーに達しないため不使用",
        "",
        "| code | biome | anchor m | pixels | map % | land % | median DEM m | max DEM m |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for code in sorted(counts, key=lambda item: (BIOMES[item]["elevation"], item)):
        mask = codes == code
        land_mask = mask & land
        median = maximum = "—"
        if land_mask.any():
            median = str(int(round(float(np.median(surface[land_mask])))))
            maximum = str(int(round(float(report["surface_max"][land_mask].max()))))
        lines.append(
            f"| `{code}` | {BIOMES[code]['jp']} | {BIOMES[code]['elevation']} | {counts[code]} | "
            f"{counts[code] / codes.size * 100:.3f}% | {land_mask.sum() / land.sum() * 100:.3f}% | "
            f"{median} | {maximum} |"
        )
    lines.extend(
        [
            "",
            "## Validation",
            "",
            f"- high-resolution unknown codes: {len(set(codes.ravel()) - ALLOWED_CODES)}",
            f"- 512px unknown codes: {len(set(resized_codes.ravel()) - ALLOWED_CODES)}",
            f"- 512px land cells: {int(resized_report['land'].sum())} / target {int(resized_report['land_target'])}",
            f"- 512px glacier cells: {int(resized_report['glacier'].sum())} / target {int(resized_report['glacier_target'])}",
            f"- longest noncoastal boundary: horizontal {horizontal[0]}px / vertical {vertical[0]}px",
            "- palette-only PNG: pass",
            "- source world-map outputs modified: no",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def generate(size: int, json_size: int) -> dict[str, Path]:
    if SOURCE_SIZE % size or SOURCE_SIZE % json_size:
        raise ValueError(f"size must divide {SOURCE_SIZE}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    source = load_source()
    codes, report = classify(source, size)
    image = image_from_codes(codes)
    validate(codes, image, report)
    resized_codes, resized_report = classify(source, json_size)
    resized_image = image_from_codes(resized_codes)
    validate(resized_codes, resized_image, resized_report)

    base = f"greenland_baffin_biome_arcticdem_{size}x{size}"
    image_path = OUTPUT_DIR / f"{base}.png"
    panel_path = OUTPUT_DIR / f"{base}_panel.png"
    audit_path = OUTPUT_DIR / f"{base}_audit.md"
    json_base = f"greenland_baffin_biome_arcticdem_{json_size}x{json_size}"
    json_png_path = OUTPUT_DIR / f"{json_base}.png"
    json_path = OUTPUT_DIR / f"{json_base}.json"

    image.save(image_path)
    compose_panel(image, codes).save(panel_path)
    resized_image.save(json_png_path)
    write_json(resized_codes, json_path)
    write_audit(audit_path, codes, report, resized_codes, resized_report)
    return {
        "image": image_path,
        "panel": panel_path,
        "json_png": json_png_path,
        "json": json_path,
        "audit": audit_path,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Greenland and Baffin regional biome maps")
    parser.add_argument("--size", type=int, default=768)
    parser.add_argument("--json-size", type=int, default=512)
    args = parser.parse_args()
    for name, path in generate(args.size, args.json_size).items():
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()
