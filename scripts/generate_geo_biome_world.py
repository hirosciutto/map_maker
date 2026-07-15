#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import subprocess
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
import shapefile
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage


DATA = Path("/tmp/blockland_geo")
ECOREGIONS = DATA / "ecoregions/Ecoregions2017.shp"
COUNTRIES = DATA / "ne/admin/countries/ne_10m_admin_0_countries.shp"
LAKES = DATA / "ne/lakes/ne_10m_lakes.shp"
GLACIERS = DATA / "ne/glaciated_areas/ne_10m_glaciated_areas.shp"
VOLCANO_CSV = DATA / "volcano_db.csv"
DEM = DATA / "dem/ETOPO_2022_v1_60s_N90W180_surface.tif"

SOURCE_DOWNLOADS = {
    "countries": (
        "https://naturalearth.s3.amazonaws.com/5.1.1/10m_cultural/ne_10m_admin_0_countries.zip",
        DATA / "ne/admin/countries.zip",
        DATA / "ne/admin/countries",
        COUNTRIES,
    ),
    "lakes": (
        "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_lakes.zip",
        DATA / "ne/lakes.zip",
        DATA / "ne/lakes",
        LAKES,
    ),
    "glaciated_areas": (
        "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_glaciated_areas.zip",
        DATA / "ne/glaciated_areas.zip",
        DATA / "ne/glaciated_areas",
        GLACIERS,
    ),
    "ecoregions": (
        "https://storage.googleapis.com/teow2016/Ecoregions2017.zip",
        DATA / "ecoregions.zip",
        DATA / "ecoregions",
        ECOREGIONS,
    ),
}
ETOPO_URL = (
    "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/"
    "60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif"
)
VOLCANO_WFS_URL = (
    "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?"
    "service=WFS&version=1.0.0&request=GetFeature&"
    "typeName=GVP-VOTW%3ASmithsonian_VOTW_Holocene_Volcanoes&outputFormat=csv"
)

OUT_DIR = Path("/Users/nakashima/works/map_maker/output")
TIBETAN_GLACIER_TARGET_KM2 = 44_400.0


BIOMES: dict[str, dict] = {
    "TWN": {"name": "town", "jp": "セントラルシティ", "color": "#808080", "category": "hub", "elevation": 50, "temp": "temperate", "humidity": "mid", "relief": "flat"},
    "PLN": {"name": "plains", "jp": "平原", "color": "#527e25", "category": "grassland", "elevation": 100, "temp": "temperate", "humidity": "mid", "relief": "flat"},
    "MDW": {"name": "meadow", "jp": "花畑メドウ", "color": "#73b234", "category": "grassland", "elevation": 150, "temp": "temperate", "humidity": "mid", "relief": "flat"},
    "SAV": {"name": "savanna", "jp": "サバンナ", "color": "#b8df90", "category": "grassland", "elevation": 250, "temp": "hot", "humidity": "dry", "relief": "flat"},
    "SHR": {"name": "shrubland", "jp": "地中海性低木", "color": "#6c6a37", "category": "grassland", "elevation": 300, "temp": "temperate", "humidity": "dry", "relief": "rolling"},
    "STP": {"name": "steppe", "jp": "温帯ステップ", "color": "#76743d", "category": "grassland", "elevation": 400, "temp": "temperate", "humidity": "dry", "relief": "flat"},
    "PLT": {"name": "plateau", "jp": "高原", "color": "#97954e", "category": "grassland", "elevation": 800, "temp": "temperate", "humidity": "mid", "relief": "rolling"},
    "SVH": {"name": "highland_savanna", "jp": "高地サバンナ", "color": "#a8a657", "category": "grassland", "elevation": 1000, "temp": "hot", "humidity": "dry", "relief": "rolling"},
    "HST": {"name": "highland_steppe", "jp": "高原ステップ", "color": "#b4b26e", "category": "grassland", "elevation": 1300, "temp": "cold", "humidity": "dry", "relief": "rolling"},
    "SST": {"name": "subalpine_steppe", "jp": "亜高山ステップ", "color": "#cecda1", "category": "grassland", "elevation": 1900, "temp": "cold", "humidity": "dry", "relief": "rolling"},
    "FOR": {"name": "forest", "jp": "森林", "color": "#2b5922", "category": "forest", "elevation": 200, "temp": "temperate", "humidity": "mid", "relief": "rolling"},
    "WDH": {"name": "wooded_hills", "jp": "山林", "color": "#428934", "category": "forest", "elevation": 500, "temp": "temperate", "humidity": "mid", "relief": "rugged"},
    "TGA": {"name": "taiga", "jp": "タイガ", "color": "#295b46", "category": "forest", "elevation": 600, "temp": "cold", "humidity": "mid", "relief": "rolling"},
    "CTG": {"name": "cold_taiga", "jp": "寒冷タイガ", "color": "#3e896a", "category": "forest", "elevation": 900, "temp": "cold", "humidity": "mid", "relief": "rolling"},
    "MFR": {"name": "montane_forest", "jp": "山地林", "color": "#88cd7a", "category": "forest", "elevation": 1100, "temp": "temperate", "humidity": "mid", "relief": "rugged"},
    "SUB": {"name": "subalpine_forest", "jp": "亜高山林", "color": "#87c9ae", "category": "forest", "elevation": 1500, "temp": "cold", "humidity": "mid", "relief": "rugged"},
    "JGL": {"name": "lowland_jungle", "jp": "平地ジャングル", "color": "#15653d", "category": "jungle", "elevation": 100, "temp": "hot", "humidity": "wet", "relief": "flat"},
    "DRF": {"name": "dry_forest", "jp": "熱帯季節林", "color": "#197647", "category": "jungle", "elevation": 300, "temp": "hot", "humidity": "mid", "relief": "rolling"},
    "DRU": {"name": "monsoon_upland", "jp": "丘陵季節林", "color": "#23a463", "category": "jungle", "elevation": 800, "temp": "hot", "humidity": "mid", "relief": "rolling"},
    "MJG": {"name": "montane_jungle", "jp": "山地ジャングル", "color": "#25ad69", "category": "jungle", "elevation": 900, "temp": "hot", "humidity": "wet", "relief": "rugged"},
    "RFM": {"name": "montane_rainforest", "jp": "中山ジャングル", "color": "#31d382", "category": "jungle", "elevation": 1400, "temp": "hot", "humidity": "wet", "relief": "rugged"},
    "CLF": {"name": "cloud_forest", "jp": "雲霧林", "color": "#68dfa3", "category": "jungle", "elevation": 2000, "temp": "hot", "humidity": "wet", "relief": "rugged"},
    "MSA": {"name": "mesa", "jp": "メサ", "color": "#9b4427", "category": "mountain", "elevation": 1000, "temp": "hot", "humidity": "dry", "relief": "rugged"},
    "RPL": {"name": "rocky_plateau", "jp": "岩石高原", "color": "#b44f2d", "category": "mountain", "elevation": 1200, "temp": "temperate", "humidity": "dry", "relief": "rolling"},
    "VOL": {"name": "volcano", "jp": "火山", "color": "#d88164", "category": "mountain", "elevation": 1800, "temp": "hot", "humidity": "dry", "relief": "peak"},
    "MTN": {"name": "mountain", "jp": "山岳", "color": "#2b2e31", "category": "mountain", "elevation": 2000, "temp": "cold", "humidity": "mid", "relief": "rugged"},
    "ARK": {"name": "alpine_rock", "jp": "高山岩稜", "color": "#43474c", "category": "mountain", "elevation": 2800, "temp": "cold", "humidity": "mid", "relief": "rugged"},
    "HRK": {"name": "high_rock", "jp": "高峰岩壁", "color": "#5b6167", "category": "mountain", "elevation": 3600, "temp": "cold", "humidity": "dry", "relief": "rugged"},
    "ALG": {"name": "alpine_grassland", "jp": "高山草原", "color": "#5c663d", "category": "alpine", "elevation": 2500, "temp": "cold", "humidity": "mid", "relief": "rolling"},
    "ALT": {"name": "alpine_tundra", "jp": "高山ツンドラ", "color": "#7e8c54", "category": "alpine", "elevation": 3000, "temp": "cold", "humidity": "dry", "relief": "rolling"},
    "SNM": {"name": "snowy_mtn", "jp": "雪の山岳", "color": "#c4c7ca", "category": "alpine", "elevation": 3500, "temp": "cold", "humidity": "mid", "relief": "peak"},
    "AFF": {"name": "alpine_fell", "jp": "高山荒原", "color": "#acb889", "category": "alpine", "elevation": 3800, "temp": "cold", "humidity": "dry", "relief": "rolling"},
    "CHL": {"name": "cold_highland", "jp": "寒冷高原", "color": "#c1c9a6", "category": "alpine", "elevation": 4200, "temp": "cold", "humidity": "dry", "relief": "flat"},
    "HMT": {"name": "high_mountain", "jp": "高山", "color": "#d1d4d6", "category": "alpine", "elevation": 4800, "temp": "cold", "humidity": "mid", "relief": "rugged"},
    "PSN": {"name": "permanent_snow", "jp": "万年雪冠", "color": "#d6d9db", "category": "alpine", "elevation": 5500, "temp": "cold", "humidity": "wet", "relief": "peak"},
    "XPK": {"name": "extreme_peak", "jp": "超高山峰", "color": "#e4e6e7", "category": "alpine", "elevation": 6800, "temp": "cold", "humidity": "dry", "relief": "peak"},
    "HIM": {"name": "himalaya", "jp": "極高山・ヒマラヤ", "color": "#f4f5f5", "category": "alpine", "elevation": 8500, "temp": "cold", "humidity": "dry", "relief": "peak"},
    "DEP": {"name": "depression", "jp": "海面下盆地", "color": "#be9c37", "category": "arid", "elevation": -200, "temp": "hot", "humidity": "dry", "relief": "flat"},
    "DSR": {"name": "desert", "jp": "砂漠", "color": "#cdae51", "category": "arid", "elevation": 200, "temp": "hot", "humidity": "dry", "relief": "rolling"},
    "THN": {"name": "thorn_scrub", "jp": "半乾燥低木", "color": "#d0b35d", "category": "arid", "elevation": 400, "temp": "hot", "humidity": "dry", "relief": "flat"},
    "DPL": {"name": "dry_plateau", "jp": "乾燥高原", "color": "#dec98c", "category": "arid", "elevation": 1000, "temp": "temperate", "humidity": "dry", "relief": "rolling"},
    "CDS": {"name": "cold_desert", "jp": "寒冷砂漠", "color": "#7e6144", "category": "arid", "elevation": 1000, "temp": "cold", "humidity": "dry", "relief": "rolling"},
    "HDS": {"name": "highland_desert", "jp": "高地砂漠", "color": "#e8dab0", "category": "arid", "elevation": 1500, "temp": "temperate", "humidity": "dry", "relief": "rolling"},
    "CDM": {"name": "montane_cold_desert", "jp": "山地寒冷砂漠", "color": "#b18f6d", "category": "arid", "elevation": 2200, "temp": "cold", "humidity": "dry", "relief": "rolling"},
    "CDH": {"name": "high_cold_desert", "jp": "高地寒冷砂漠", "color": "#cdb7a2", "category": "arid", "elevation": 3200, "temp": "cold", "humidity": "dry", "relief": "flat"},
    "SLT": {"name": "salt_flat", "jp": "塩原", "color": "#cdb8a2", "category": "arid", "elevation": 3600, "temp": "cold", "humidity": "dry", "relief": "flat"},
    "PLR": {"name": "polar_desert", "jp": "極地砂漠", "color": "#91c5ca", "category": "frozen", "elevation": 100, "temp": "cold", "humidity": "dry", "relief": "flat"},
    "SNW": {"name": "snowfield", "jp": "雪原", "color": "#94c7cc", "category": "frozen", "elevation": 300, "temp": "cold", "humidity": "mid", "relief": "flat"},
    "TND": {"name": "tundra", "jp": "ツンドラ", "color": "#98c9cd", "category": "frozen", "elevation": 400, "temp": "cold", "humidity": "dry", "relief": "flat"},
    "ICE": {"name": "ice_sheet", "jp": "氷床", "color": "#9bcbcf", "category": "frozen", "elevation": 500, "temp": "cold", "humidity": "wet", "relief": "flat"},
    "IFD": {"name": "icefield", "jp": "氷原", "color": "#acd4d7", "category": "frozen", "elevation": 1200, "temp": "cold", "humidity": "wet", "relief": "rolling"},
    "GLC": {"name": "glacier", "jp": "氷河", "color": "#a6b9c9", "category": "frozen", "elevation": 2000, "temp": "cold", "humidity": "wet", "relief": "rugged"},
    "IDM": {"name": "ice_dome", "jp": "氷冠高原", "color": "#e3f1f2", "category": "frozen", "elevation": 3500, "temp": "cold", "humidity": "wet", "relief": "flat"},
    "HGL": {"name": "high_glacier", "jp": "高地氷河", "color": "#ccd7e0", "category": "frozen", "elevation": 4500, "temp": "cold", "humidity": "wet", "relief": "rugged"},
    "WET": {"name": "wetland", "jp": "湿地", "color": "#38756b", "category": "wetland", "elevation": 50, "temp": "temperate", "humidity": "wet", "relief": "flat"},
    "MOR": {"name": "high_moor", "jp": "高層湿原", "color": "#9fd1c8", "category": "wetland", "elevation": 1200, "temp": "cold", "humidity": "wet", "relief": "flat"},
    "TRN": {"name": "ocean_trench", "jp": "海溝", "color": "#102437", "category": "coastal", "elevation": -8000, "temp": "cold", "humidity": "wet", "relief": "rugged"},
    "DPO": {"name": "deep_ocean", "jp": "深海", "color": "#1e4267", "category": "coastal", "elevation": -4000, "temp": "cold", "humidity": "wet", "relief": "rolling"},
    "SHF": {"name": "shelf_sea", "jp": "浅海・大陸棚", "color": "#2c6196", "category": "coastal", "elevation": -100, "temp": "temperate", "humidity": "wet", "relief": "flat"},
    "OCN": {"name": "ocean", "jp": "海", "color": "#3270ae", "category": "coastal", "elevation": 0, "temp": "temperate", "humidity": "wet", "relief": "flat"},
    "MNG": {"name": "mangrove", "jp": "マングローブ", "color": "#356e65", "category": "coastal", "elevation": 0, "temp": "hot", "humidity": "wet", "relief": "flat"},
    "BCH": {"name": "beach", "jp": "浜", "color": "#ffe1b2", "category": "coastal", "elevation": 5, "temp": "temperate", "humidity": "wet", "relief": "flat"},
    "ISL": {"name": "tropic_isle", "jp": "南国の島", "color": "#ebe547", "category": "coastal", "elevation": 20, "temp": "hot", "humidity": "wet", "relief": "rolling"},
}

RGB = {
    code: tuple(int(biome["color"].lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))
    for code, biome in BIOMES.items()
}


def run_curl(url: str, destination: Path, resume: bool = False) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = ["curl", "-k", "-L", "--fail", "--retry", "5", "-sS"]
    if resume and destination.exists():
        command.extend(["-C", "-"])
    command.extend([url, "-o", str(destination)])
    subprocess.run(command, check=True)


def ensure_source_data() -> None:
    for url, archive, destination, required in SOURCE_DOWNLOADS.values():
        if required.exists():
            continue
        run_curl(url, archive)
        destination.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            source.extractall(destination)
    if not DEM.exists() or DEM.stat().st_size < 400_000_000:
        run_curl(ETOPO_URL, DEM, resume=True)
    if not VOLCANO_CSV.exists() or VOLCANO_CSV.stat().st_size < 10_000:
        run_curl(VOLCANO_WFS_URL, VOLCANO_CSV)


RECIPE_MONITORS: list[dict] = [
    {
        "name": "ヒマラヤ／カラコルム",
        "coords": [(73, 36), (77, 37), (82, 36.5), (88, 34), (96, 31), (98, 28), (91, 28), (84, 30), (76, 33), (70, 35)],
        "allowed": {"JGL", "DRF", "FOR", "MFR", "SUB", "ARK", "HRK", "HGL", "HMT", "PSN", "XPK", "HIM"},
        "forbidden_external": {"RPL", "PLT", "WET", "MNG"},
    },
    {
        "name": "チベット高原",
        "coords": [(78, 33), (86, 34.5), (96, 34), (103, 31), (101, 28), (92, 29), (82, 30), (76, 31)],
        "allowed": {"CHL", "CDM", "CDH", "SST", "HMT"},
        "forbidden_external": {"RPL", "PLT", "WET", "MNG"},
    },
    {
        "name": "中央アジア（カザフ〜天山・パミール）",
        "coords": [(68, 43), (75, 45), (84, 44), (90, 41), (84, 39), (74, 40)],
        "allowed": {"STP", "HST", "CDS", "HDS", "CDM", "CDH", "MTN", "ARK", "HRK", "HGL", "HMT", "XPK"},
        "forbidden_external": {"RPL", "PLT"},
    },
    {
        "name": "タリム盆地",
        "coords": [(75, 41), (82, 42), (90, 40), (90, 37), (82, 36), (76, 37)],
        "max_elevation": 1800,
        "allowed": {"DSR", "CDS", "HDS"},
        "replacement_allowed": {"DSR", "CDS", "HDS"},
        "forbidden_external": {"RPL", "PLT", "FOR", "WDH", "TGA", "CTG", "MFR", "SUB"},
    },
    {
        "name": "モンゴル・ゴビ",
        "coords": [(92, 44), (104, 46), (116, 44), (114, 40), (101, 39), (91, 41)],
        "allowed": {"HST", "CDS", "MTN", "CDM", "HMT"},
        "forbidden_external": {"PLT"},
    },
    {
        "name": "ツァイダム盆地",
        "coords": [(90.5, 38.5), (94, 39), (98.5, 37.5), (98, 35.5), (94, 35.2), (91, 36.2)],
        "max_elevation": 3400,
        "max_relief": 1800,
        "allowed": {"CDS", "HDS", "CDM", "CDH", "CHL"},
        "replacement_allowed": {"CDS", "HDS", "CDM", "CDH", "CHL"},
        "forbidden_external": {"FOR", "WDH", "TGA", "CTG", "MFR", "SUB", "ARK", "HRK", "HGL", "HMT", "SNM", "PSN", "IFD", "GLC"},
    },
    {
        "name": "モンゴル高原北部",
        "coords": [(96, 48), (105, 49), (116, 47), (116, 43), (104, 42), (94, 44)],
        "allowed": {"HST", "STP", "FOR", "TGA", "WDH"},
        "forbidden_external": {"PLT"},
    },
    {
        "name": "ロッキー山脈",
        "coords": [(-126, 61), (-118, 57), (-112, 49), (-106, 41), (-104, 35), (-109, 31), (-116, 39), (-124, 50), (-132, 58)],
        "allowed": {"MFR", "MTN", "ARK", "HGL", "HMT", "PSN"},
        "forbidden_external": {"RPL", "PLT"},
    },
    {
        "name": "北米南西部砂漠",
        "coords": [(-122, 36), (-117, 34), (-114, 31), (-109, 29), (-104, 31), (-105, 36), (-113, 38)],
        "allowed": {"DSR", "DPL", "MSA", "DEP", "THN"},
        "forbidden_external": {"RPL", "PLT"},
    },
    {
        "name": "グレートプレーンズ",
        "coords": [(-104.5, 49), (-97, 49), (-96, 30), (-101, 28), (-104.5, 39)],
        "allowed": {"STP", "PLN", "PLT", "HST"},
        "forbidden_external": {"RPL", "ALT"},
    },
    {
        "name": "アンデス",
        "coords": [(-80, 9), (-76, 7), (-72, -8), (-69, -20), (-68, -34), (-70, -51), (-73, -55), (-76, -35), (-79, -15)],
        "allowed": {"JGL", "RFM", "CLF", "AFF", "CHL", "HGL", "PSN", "XPK", "HMT", "MTN", "CDS", "CDM", "CDH", "IFD", "GLC"},
        "forbidden_external": {"RPL", "PLT"},
    },
    {
        "name": "アルプス・カルパティア",
        "coords": [(5, 45), (8, 47), (14, 48), (17, 46), (14, 44), (7, 44)],
        "allowed": {"FOR", "MFR", "SUB", "ARK", "GLC", "HGL", "HMT", "PSN"},
        "forbidden_external": {"RPL", "PLT"},
    },
    {
        "name": "イラン高原・アナトリア",
        "coords": [(31, 39), (38, 41), (44, 39), (41, 36), (33, 37)],
        "allowed": {"CDS", "DPL", "MTN", "HMT", "STP", "HST", "PSN"},
        "forbidden_external": {"PLT"},
    },
    {
        "name": "アラビア・メソポタミア・レバント",
        "coords": [(38, 34), (57, 35), (64, 31), (60, 20), (43, 16), (34, 25)],
        "allowed": {"DSR", "WET", "DRF", "SHR", "DEP", "RPL", "DPL"},
        "forbidden_external": {"PLT", "ALT"},
    },
    {
        "name": "サヘル",
        "coords": [(-18, 15), (-5, 13), (10, 12), (28, 14), (38, 18), (34, 23), (12, 22), (-9, 20)],
        "allowed": {"THN", "SAV"},
    },
    {
        "name": "東アフリカ高地",
        "coords": [(32, 14), (43, 13), (43, -4), (35, -4), (32, 8)],
        "allowed": {"SAV", "SVH", "PLT", "WET", "HMT", "PSN", "VOL"},
    },
    {
        "name": "オーストラリア内陸",
        "coords": [(116, -20), (126, -18), (139, -21), (144, -27), (139, -33), (126, -33), (116, -29)],
        "allowed": {"DSR", "RPL", "THN"},
    },
    {
        "name": "東南アジア大陸部",
        "coords": [(95, 24), (105, 22), (108, 14), (104, 10), (98, 16)],
        "allowed": {"DRF", "DRU", "JGL", "MJG", "RFM", "MTN", "CLF", "WET", "MNG"},
    },
    {
        "name": "ニューギニア中央山系",
        "coords": [(132, -2.5), (136, -3.0), (140, -3.5), (145, -4.5), (149, -6.0), (147, -7.0), (142, -6.0), (138, -5.0), (134, -4.5)],
        "allowed": {"JGL", "RFM", "CLF", "HMT", "PSN"},
        "forbidden_external": {"RPL", "PLT", "WET", "MNG"},
        "min_elevation": 800,
    },
]


MOUNTAIN_FOOTPRINT_CODES = {
    "WDH", "TGA", "CTG", "MFR", "SUB", "DRU", "MJG", "RFM", "CLF",
    "SVH", "HST", "SST", "HDS", "CDM", "ALG", "MTN", "ARK", "HRK",
    "TND", "ICE", "ALT", "AFF", "SNM", "IFD", "GLC", "HGL", "HMT",
    "PSN", "XPK", "HIM", "VOL",
}


# A named range is an envelope, not a painted line. The polyline only identifies
# the geographic axis; DEM elevation and relief determine the irregular footprint.
NAMED_MOUNTAIN_RANGES: list[dict] = [
    {"name": "アラスカ山脈", "points": [(-153, 63), (-147, 62.5), (-141, 61)], "width": 4.5, "min_elev": 550, "min_relief": 500},
    {"name": "ブルックス山脈", "points": [(-161, 68), (-151, 68), (-141, 68)], "width": 3.5, "min_elev": 450, "min_relief": 400},
    {"name": "北米海岸山地・カスケード", "points": [(-132, 58), (-126, 51), (-122, 43), (-119, 36)], "width": 4.0, "min_elev": 500, "min_relief": 450},
    {"name": "ロッキー山脈", "points": [(-121, 59), (-115, 52), (-111, 45), (-106, 38), (-106, 32)], "width": 6.0, "min_elev": 700, "min_relief": 450},
    {"name": "シエラネバダ", "points": [(-121, 40), (-119, 37), (-117, 34)], "width": 2.5, "min_elev": 700, "min_relief": 500},
    {"name": "アパラチア山脈", "points": [(-85, 34), (-81, 38), (-78, 41), (-73, 46)], "width": 4.5, "min_elev": 250, "min_relief": 220},
    {"name": "シエラマドレ", "points": [(-108, 31), (-105, 26), (-102, 21), (-98, 18)], "width": 5.0, "min_elev": 650, "min_relief": 450},
    {"name": "アンデス山脈", "points": [(-78, 9), (-75, 0), (-72, -12), (-69, -25), (-70, -38), (-73, -52)], "width": 5.5, "min_elev": 650, "min_relief": 500},
    {"name": "スカンディナビア山脈", "points": [(-4, 61), (5, 64), (13, 67), (20, 70)], "width": 3.5, "min_elev": 350, "min_relief": 300},
    {"name": "ピレネー山脈", "points": [(-1.5, 43), (1.5, 42.7), (3.2, 42.5)], "width": 2.0, "min_elev": 550, "min_relief": 400},
    {"name": "アルプス山脈", "points": [(5, 45.5), (9, 46.5), (13, 47), (16, 46.5)], "width": 2.8, "min_elev": 500, "min_relief": 400},
    {"name": "アペニン山脈", "points": [(8, 44), (11, 42), (14, 39)], "width": 2.0, "min_elev": 350, "min_relief": 300},
    {"name": "カルパティア山脈", "points": [(17, 48), (21, 49), (25, 47), (26, 44)], "width": 3.0, "min_elev": 400, "min_relief": 320},
    {"name": "ディナル・バルカン山系", "points": [(14, 46), (18, 43), (23, 42)], "width": 3.0, "min_elev": 350, "min_relief": 300},
    {"name": "ウラル山脈", "points": [(60, 67), (59, 60), (59, 54), (57, 50)], "width": 3.0, "min_elev": 250, "min_relief": 220},
    {"name": "コーカサス山脈", "points": [(39, 43), (44, 42.5), (49, 42)], "width": 2.5, "min_elev": 650, "min_relief": 500},
    {"name": "アトラス山脈", "points": [(-10, 31), (-5, 32), (1, 35), (9, 36)], "width": 4.0, "min_elev": 500, "min_relief": 400},
    {"name": "エチオピア高地", "points": [(36, 14), (39, 10), (40, 6)], "width": 5.0, "min_elev": 900, "min_relief": 450},
    {"name": "東アフリカ山地", "points": [(30, 1), (35, -5), (36, -12)], "width": 4.5, "min_elev": 850, "min_relief": 450},
    {"name": "ドラケンスバーグ山脈", "points": [(29, -23), (29, -28), (27, -33)], "width": 3.0, "min_elev": 700, "min_relief": 400},
    {"name": "タウルス山脈", "points": [(28, 37), (34, 38), (41, 37)], "width": 2.8, "min_elev": 600, "min_relief": 400},
    {"name": "ザグロス山脈", "points": [(44, 36), (48, 32), (53, 28)], "width": 4.0, "min_elev": 700, "min_relief": 450},
    {"name": "エルブルズ山脈", "points": [(48, 36), (53, 36.5), (57, 36)], "width": 2.5, "min_elev": 650, "min_relief": 450},
    {"name": "ヒンドゥークシュ", "points": [(67, 35), (71, 36), (74, 36)], "width": 3.0, "min_elev": 1000, "min_relief": 550},
    {"name": "パミール高原山系", "points": [(71, 39), (74, 38.5), (76, 39)], "width": 3.5, "min_elev": 1200, "min_relief": 550},
    {"name": "天山山脈", "points": [(69, 42), (77, 42), (84, 43), (89, 43)], "width": 4.0, "min_elev": 900, "min_relief": 500},
    {"name": "崑崙山脈", "points": [(75, 36), (84, 36), (92, 35.5), (99, 35)], "width": 3.5, "min_elev": 1300, "min_relief": 500},
    {"name": "ヒマラヤ・カラコルム", "points": [(72, 35), (78, 34), (84, 30.5), (91, 28), (97, 29)], "width": 4.5, "min_elev": 1200, "min_relief": 550},
    {"name": "アルタイ山脈", "points": [(84, 48), (90, 49), (96, 48)], "width": 4.0, "min_elev": 700, "min_relief": 450},
    {"name": "サヤン山脈", "points": [(90, 52), (97, 52), (104, 51)], "width": 3.5, "min_elev": 600, "min_relief": 400},
    {"name": "横断山脈", "points": [(96, 33), (99, 29), (101, 24)], "width": 4.0, "min_elev": 900, "min_relief": 500},
    {"name": "秦嶺山脈", "points": [(103, 34), (108, 33.5), (113, 33)], "width": 3.0, "min_elev": 500, "min_relief": 350},
    {"name": "日本列島山系", "points": [(130, 32), (135, 36), (140, 40), (145, 44)], "width": 2.2, "min_elev": 300, "min_relief": 350},
    {"name": "アンナン山脈", "points": [(103, 21), (105, 17), (107, 13)], "width": 2.8, "min_elev": 350, "min_relief": 300},
    {"name": "ニューギニア中央山系", "points": [(132, -3), (139, -4), (145, -5), (149, -6)], "width": 3.5, "min_elev": 700, "min_relief": 450},
    {"name": "大分水嶺山脈", "points": [(145, -18), (151, -25), (149, -33), (147, -38)], "width": 3.5, "min_elev": 300, "min_relief": 260},
    {"name": "ニュージーランド南アルプス", "points": [(168, -46), (171, -43), (173, -41)], "width": 2.5, "min_elev": 450, "min_relief": 400, "profile": "temperate_wet"},
]


WORLD_REGION_REVIEWS: list[dict] = [
    {"name": "グリーンランド", "coords": [(-74, 59), (-10, 59), (-10, 84), (-74, 84)], "core": {"ICE", "IFD", "IDM", "GLC", "SNM", "PLR", "TND"}},
    {"name": "カナダ北部と北極の島々", "coords": [(-140, 58), (-55, 58), (-55, 84), (-140, 84)], "core": {"TGA", "CTG", "TND", "PLR", "ICE", "IFD", "GLC"}},
    {"name": "アラスカ", "coords": [(-170, 51), (-130, 51), (-130, 72), (-170, 72)], "core": {"TGA", "CTG", "TND", "MFR", "SUB", "MTN", "SNM", "GLC"}},
    {"name": "北アメリカ西部", "coords": [(-130, 25), (-102, 25), (-102, 60), (-130, 60)], "core": {"TGA", "CTG", "MFR", "SUB", "WDH", "MTN", "ARK", "STP", "PLT", "DSR", "MSA", "SHR"}},
    {"name": "北アメリカ中央平原", "coords": [(-105, 28), (-90, 28), (-90, 55), (-105, 55)], "core": {"PLN", "STP", "PLT", "HST", "FOR"}},
    {"name": "北アメリカ東部", "coords": [(-92, 25), (-60, 25), (-60, 55), (-92, 55)], "core": {"FOR", "TGA", "STP", "WDH", "MFR", "PLN", "WET", "MNG"}},
    {"name": "メキシコ・中央アメリカ・カリブ海", "coords": [(-118, 7), (-58, 7), (-58, 32), (-118, 32)], "core": {"DSR", "THN", "DPL", "HDS", "CDM", "STP", "HST", "MFR", "WDH", "DRF", "JGL", "MJG", "CLF", "MNG", "VOL"}},
    {"name": "アマゾン川流域", "coords": [(-80, -18), (-45, -18), (-45, 8), (-80, 8)], "core": {"JGL", "MJG", "RFM", "WET", "MNG"}},
    {"name": "アンデス山脈", "coords": [(-82, 12), (-73, 12), (-67, -12), (-62, -25), (-67, -56), (-76, -56), (-75, -30), (-80, -5)], "core": {"JGL", "FOR", "STP", "MJG", "RFM", "CLF", "ALG", "HST", "CDM", "CDH", "MTN", "ARK", "HRK", "CHL", "HMT", "PSN", "GLC", "HGL"}},
    {"name": "ブラジル高原と南アメリカ東部", "coords": [(-65, -35), (-34, -35), (-34, 2), (-65, 2)], "core": {"SAV", "SVH", "DRF", "THN", "PLT", "FOR", "JGL", "WET"}},
    {"name": "パンパとパタゴニア", "coords": [(-75, -56), (-52, -56), (-52, -28), (-75, -28)], "core": {"STP", "HST", "RPL", "DSR", "SHR", "SAV", "FOR", "MTN", "GLC", "IFD"}},
    {"name": "西ヨーロッパ", "coords": [(-12, 42), (16, 42), (16, 60), (-12, 60)], "core": {"FOR", "PLN", "WDH", "MFR", "SHR", "STP", "WET"}},
    {"name": "北ヨーロッパ", "coords": [(-12, 55), (32, 55), (32, 72), (-12, 72)], "core": {"FOR", "TGA", "CTG", "TND", "WDH", "MFR", "SUB", "MTN"}},
    {"name": "南ヨーロッパと地中海沿岸", "coords": [(-10, 34), (32, 34), (32, 47), (-10, 47)], "core": {"SHR", "FOR", "STP", "DPL", "WDH", "MFR", "MTN", "ARK"}},
    {"name": "東ヨーロッパ", "coords": [(16, 44), (45, 44), (45, 60), (16, 60)], "core": {"FOR", "PLN", "STP", "TGA", "WET", "MFR"}},
    {"name": "西シベリア", "coords": [(45, 48), (90, 48), (90, 72), (45, 72)], "core": {"STP", "FOR", "TGA", "CTG", "TND", "PLR", "WET", "MOR", "PLT"}},
    {"name": "中央・東シベリア", "coords": [(90, 48), (180, 48), (180, 76), (90, 76)], "core": {"TGA", "CTG", "TND", "PLR", "PLT", "MFR", "SUB", "MTN", "VOL"}},
    {"name": "サハラ砂漠", "coords": [(-17, 17), (35, 17), (35, 33), (-17, 33)], "core": {"DSR", "RPL", "DPL", "MTN"}},
    {"name": "サヘルと西アフリカ", "coords": [(-18, 5), (20, 5), (20, 18), (-18, 18)], "core": {"THN", "SAV", "DRF", "JGL", "MNG"}},
    {"name": "コンゴ盆地", "coords": [(10, -4), (16, -9), (27, -7), (31, -2), (29, 5), (19, 6), (10, 2)], "core": {"JGL", "MJG", "RFM", "WET"}},
    {"name": "東アフリカ", "coords": [(28, -15), (48, -15), (48, 15), (28, 15)], "core": {"SAV", "SVH", "THN", "JGL", "MJG", "PLT", "HST", "WET", "MFR", "MTN", "VOL"}},
    {"name": "アフリカ南部", "coords": [(10, -36), (36, -36), (36, -15), (10, -15)], "core": {"DSR", "HDS", "CDM", "THN", "SAV", "SVH", "HST", "RPL", "SHR", "WDH", "MTN"}},
    {"name": "マダガスカル", "coords": [(42, -27), (51, -27), (51, -11), (42, -11)], "core": {"JGL", "MJG", "DRF", "THN", "PLT", "HST", "RFM"}},
    {"name": "アラビア半島", "coords": [(34, 12), (60, 12), (60, 32), (34, 32)], "core": {"DSR", "HDS", "CDM", "RPL", "DPL", "THN", "SHR", "WET"}},
    {"name": "トルコ・イラン・コーカサス", "coords": [(26, 25), (65, 25), (65, 44), (26, 44)], "core": {"DSR", "HDS", "STP", "HST", "DPL", "CDS", "CDM", "MFR", "MTN", "ARK", "HMT"}},
    {"name": "カザフスタンと中央アジア", "coords": [(45, 35), (90, 35), (90, 55), (45, 55)], "core": {"STP", "HST", "CDS", "DPL", "HDS", "CDM", "MTN", "ARK"}},
    {"name": "モンゴルとゴビ砂漠", "coords": [(85, 37), (120, 37), (120, 53), (85, 53)], "core": {"STP", "FOR", "TGA", "HST", "CDS", "HDS", "CDM", "RPL", "MTN"}},
    {"name": "チベット高原とヒマラヤ", "coords": [(70, 35), (78, 37), (91, 35), (104, 32), (101, 27), (89, 28), (78, 30)], "core": {"CHL", "CDH", "CDM", "SST", "ALG", "ARK", "HRK", "HMT", "HGL", "PSN", "XPK", "HIM"}},
    {"name": "中国東部・朝鮮半島・日本", "coords": [(100, 18), (150, 18), (150, 48), (100, 48)], "core": {"PLN", "STP", "HST", "FOR", "WDH", "MFR", "DRF", "JGL", "MJG", "WET", "TGA", "VOL"}},
    {"name": "インド亜大陸", "coords": [(66, 6), (92, 6), (92, 30), (66, 30)], "core": {"DRF", "DRU", "STP", "PLT", "DSR", "WET", "JGL", "MJG", "RFM", "CLF"}},
    {"name": "東南アジア大陸部", "coords": [(92, 5), (110, 5), (110, 28), (92, 28)], "core": {"DRF", "DRU", "JGL", "MJG", "RFM", "CLF", "WET", "MNG"}},
    {"name": "インドネシア・フィリピン・ニューギニア", "coords": [(110, -12), (155, -12), (155, 22), (110, 22)], "core": {"JGL", "MJG", "RFM", "CLF", "MNG", "VOL", "HMT", "PSN"}},
    {"name": "オーストラリア", "coords": [(112, -45), (155, -45), (155, -10), (112, -10)], "core": {"DSR", "THN", "SAV", "RPL", "SHR", "FOR", "WDH", "MFR", "MTN", "MNG"}},
    {"name": "ニュージーランド", "coords": [(164, -49), (180, -49), (180, -33), (164, -33)], "core": {"FOR", "WDH", "MFR", "SUB", "MTN", "GLC", "VOL"}},
    {"name": "南極大陸", "coords": [(-180, -90), (180, -90), (180, -60), (-180, -60)], "core": {"ICE", "IFD", "IDM", "GLC", "SNM", "HMT", "PLR"}},
]


def contains_any(text: str, words: tuple[str, ...]) -> bool:
    return any(word in text for word in words)


def split_parts(shape):
    points = shape.points
    parts = list(shape.parts) + [len(points)]
    for idx in range(len(parts) - 1):
        yield points[parts[idx] : parts[idx + 1]]


def lonlat_to_xy(lon: float, lat: float, width: int, height: int) -> tuple[int, int]:
    x = int(round((lon + 180.0) / 360.0 * (width - 1)))
    y = int(round((90.0 - lat) / 180.0 * (height - 1)))
    return x, y


def project_part(part, width: int, height: int):
    projected = []
    previous_lon = None
    for lon, lat in part:
        if previous_lon is not None and abs(lon - previous_lon) > 180:
            return None
        previous_lon = lon
        projected.append(lonlat_to_xy(lon, lat, width, height))
    return projected if len(projected) >= 3 else None


def project_line_segments(part, width: int, height: int):
    line = []
    previous_lon = None
    for lon, lat in part:
        if previous_lon is not None and abs(lon - previous_lon) > 180:
            if len(line) >= 2:
                yield line
            line = []
        previous_lon = lon
        line.append(lonlat_to_xy(lon, lat, width, height))
    if len(line) >= 2:
        yield line


def draw_shape_file_mask(path: Path, width: int, height: int, skip_antarctica: bool = False) -> Image.Image:
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    sf = shapefile.Reader(str(path), encoding="latin1")
    for sr in sf.iterShapeRecords():
        if skip_antarctica and sr.record.as_dict().get("ADMIN") == "Antarctica":
            continue
        for part in split_parts(sr.shape):
            poly = project_part(part, width, height)
            if poly is not None:
                draw.polygon(poly, fill=255)
    return mask


def draw_polygons(img: Image.Image, path: Path, code: str, max_scalerank: int | None = None) -> None:
    draw = ImageDraw.Draw(img)
    sf = shapefile.Reader(str(path), encoding="latin1")
    color = RGB[code]
    for sr in sf.iterShapeRecords():
        rec = sr.record.as_dict()
        scalerank = rec.get("scalerank")
        if max_scalerank is not None and scalerank is not None and scalerank > max_scalerank:
            continue
        for part in split_parts(sr.shape):
            poly = project_part(part, img.width, img.height)
            if poly is not None:
                draw.polygon(poly, fill=color)


def draw_country_borders(base: Image.Image) -> Image.Image:
    out = base.convert("RGB")
    draw = ImageDraw.Draw(out, "RGBA")
    sf = shapefile.Reader(str(COUNTRIES), encoding="latin1")
    for sr in sf.iterShapeRecords():
        if sr.record.as_dict().get("ADMIN") == "Antarctica":
            continue
        for part in split_parts(sr.shape):
            for line in project_line_segments(part, out.width, out.height):
                draw.line(line, fill=(255, 255, 255, 120), width=2)
                draw.line(line, fill=(10, 12, 14, 210), width=1)
    return out


def ecoregion_to_code(rec: dict, shape) -> str:
    biome = rec["BIOME_NAME"]
    eco = rec["ECO_NAME"].lower()
    realm = rec["REALM"]
    minx, miny, maxx, maxy = shape.bbox
    center_lat = (miny + maxy) / 2
    center_lon = (minx + maxx) / 2
    islandish = realm in {"Australasia", "Oceania"} or contains_any(
        eco, ("island", "islands", "archipelago", "hawaii", "fiji", "samoa", "tonga", "marquesas", "mascarene", "seychelles")
    )

    if biome == "N/A":
        return "PLN"
    if biome == "Mangroves" or contains_any(eco, ("mangrove", "sundarbans", "niger delta")):
        return "MNG"
    if biome == "Flooded Grasslands & Savannas" or contains_any(
        eco, ("swamp", "flooded", "marsh", "delta", "everglades", "sudd", "pantanal", "varzea", "igapo")
    ):
        if contains_any(eco, ("moor", "bog", "peat", "puna", "paramo", "páramo", "tibetan", "andean", "highland")):
            return "MOR"
        return "WET"
    if biome == "Tundra":
        if realm == "Antarctica" or center_lat < -62 or contains_any(eco, ("ice", "antarctic")):
            return "ICE"
        if contains_any(eco, ("polar desert", "dry valley")):
            return "PLR"
        if contains_any(eco, ("alpine", "altai", "himalaya", "pamir", "tibetan", "andes", "rocky mountain", "caucasus")):
            return "ALT"
        return "TND"
    if biome == "Boreal Forests/Taiga":
        if contains_any(eco, ("subalpine", "alpine", "montane", "mountain", "altai", "sayan", "rocky mountain", "scandinavian")):
            return "SUB"
        return "CTG" if center_lat > 62 or contains_any(eco, ("northeast siberian", "taiga-tundra", "yukon")) else "TGA"
    if biome == "Deserts & Xeric Shrublands":
        if contains_any(eco, ("colorado plateau", "grand canyon", "canyonlands", "mesa", "badlands", "red rock", "monument")):
            return "MSA"
        if contains_any(eco, ("taklimakan", "taklamakan", "tarim", "qaidam", "ladakh", "altiplano", "atacama", "tibetan plateau")):
            return "HDS"
        if contains_any(eco, ("tibetan", "pamir", "kunlun", "karakoram", "himalaya")):
            return "CDH"
        if contains_any(eco, ("gobi", "alashan", "junggar", "cold desert")) or center_lat > 38:
            return "CDS"
        if contains_any(eco, ("hamada", "stony", "rock", "rocky", "registan", "namib", "patagonian steppe")):
            return "RPL"
        if contains_any(eco, ("plateau", "highland", "iranian", "anatolian")):
            return "DPL"
        return "DSR"
    if biome == "Montane Grasslands & Shrublands":
        if contains_any(eco, ("himalayan alpine shrub", "papuan central range sub-alpine")):
            return "ALG"
        if contains_any(eco, ("karakoram-west tibetan plateau alpine steppe", "hindu kush alpine meadow")):
            return "SST"
        if contains_any(eco, ("puna", "altiplano", "tibetan", "tibet", "qinghai")):
            return "CHL"
        if contains_any(eco, ("pamir", "tien shan", "kunlun", "caucasus", "andes", "rocky")):
            return "ALG"
        if contains_any(eco, ("paramo", "páramo", "alpine fell")):
            return "AFF"
        if contains_any(eco, ("steppe", "mongolian", "altai")):
            return "HST"
        if contains_any(eco, ("ethiopian", "deccan")):
            return "PLT"
        return "HST"
    if biome == "Tropical & Subtropical Moist Broadleaf Forests":
        if contains_any(eco, ("cloud forest", "cloud forests", "yungas", "kinabalu", "eastern arc", "cameroon highlands")):
            return "CLF"
        if contains_any(eco, ("montane", "highland", "mountain", "new guinea highlands", "bornean montane")):
            return "RFM" if center_lat < 23 and center_lat > -23 else "MJG"
        return "MJG" if islandish and abs(center_lat) < 24 else "JGL"
    if biome == "Tropical & Subtropical Dry Broadleaf Forests":
        if contains_any(eco, ("thorn", "caatinga", "spiny")):
            return "THN"
        return "DRF"
    if biome == "Tropical & Subtropical Coniferous Forests":
        return "MFR"
    if biome == "Tropical & Subtropical Grasslands, Savannas & Shrublands":
        if contains_any(eco, ("thorn", "sahel", "caatinga")):
            return "THN"
        if contains_any(eco, ("highland", "montane", "ethiopian")):
            return "SVH"
        return "SAV"
    if biome == "Temperate Grasslands, Savannas & Shrublands":
        if contains_any(eco, ("mongolian", "altai", "patagonian")):
            return "HST"
        return "STP"
    if biome == "Mediterranean Forests, Woodlands & Scrub":
        return "SHR"
    if biome == "Temperate Broadleaf & Mixed Forests":
        if contains_any(eco, ("montane", "mountain", "alps", "appalachian", "caucasus", "himalayan", "qinling", "dinaric", "carpathian")):
            return "MFR"
        return "FOR"
    if biome == "Temperate Conifer Forests":
        if contains_any(eco, ("subalpine", "alpine", "montane", "rocky", "sierra", "cascades", "alps")):
            return "SUB"
        return "TGA" if center_lat > 55 else "MFR"
    if center_lon or center_lat:
        return "PLN"
    return "PLN"


def render_ecoregions(width: int, height: int) -> Image.Image:
    img = Image.new("RGB", (width, height), RGB["OCN"])
    draw = ImageDraw.Draw(img)
    sf = shapefile.Reader(str(ECOREGIONS), encoding="latin1")
    items = []
    for sr in sf.iterShapeRecords():
        rec = sr.record.as_dict()
        area = abs(rec.get("SHAPE_AREA", 0) or 0)
        items.append((area, rec, sr.shape))
    items.sort(reverse=True, key=lambda item: item[0])
    for _, rec, shape in items:
        color = RGB[ecoregion_to_code(rec, shape)]
        for part in split_parts(shape):
            poly = project_part(part, width, height)
            if poly is not None:
                draw.polygon(poly, fill=color)
    return img


def sample_dem(width: int, height: int) -> np.ndarray:
    with rasterio.open(DEM) as src:
        xs = np.linspace(-180 + 180 / width, 180 - 180 / width, width)
        ys = np.linspace(90 - 90 / height, -90 + 90 / height, height)
        lon_grid, lat_grid = np.meshgrid(xs, ys)
        coords = np.column_stack([lon_grid.ravel(), lat_grid.ravel()])
        values = np.fromiter((v[0] for v in src.sample(coords)), dtype=np.float32, count=width * height)
        values = values.reshape((height, width))
        values[values < -12000] = np.nan
        return values


def code_array_from_image(img: Image.Image) -> np.ndarray:
    arr = np.array(img.convert("RGB"))
    color_to_code = {RGB[code]: code for code in BIOMES}
    out = np.full((img.height, img.width), "OCN", dtype="<U3")
    for color, code in color_to_code.items():
        mask = np.all(arr == color, axis=2)
        out[mask] = code
    return out


def image_from_code_array(codes: np.ndarray) -> Image.Image:
    height, width = codes.shape
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    for code, rgb in RGB.items():
        arr[codes == code] = rgb
    return Image.fromarray(arr, "RGB")


def polygon_mask(width: int, height: int, coords: list[tuple[float, float]], blur: float = 0.0, threshold: int = 128) -> np.ndarray:
    mask = Image.new("L", (width, height), 0)
    points = [lonlat_to_xy(lon, lat, width, height) for lon, lat in coords]
    ImageDraw.Draw(mask).polygon(points, fill=255)
    arr = np.array(mask, dtype=np.float32)
    if blur:
        arr = ndimage.gaussian_filter(arr, blur)
    return arr >= threshold


def mountain_envelope_mask(width: int, height: int, spec: dict) -> np.ndarray:
    """Rasterize a named range axis as a broad geographic envelope."""
    mask = Image.new("L", (width, height), 0)
    points = [lonlat_to_xy(lon, lat, width, height) for lon, lat in spec["points"]]
    line_width = max(2, int(round(float(spec["width"]) / 360 * width)))
    draw = ImageDraw.Draw(mask)
    draw.line(points, fill=255, width=line_width, joint="curve")
    radius = line_width // 2
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    return np.array(mask) > 0


def remove_small_components(mask: np.ndarray, minimum: int) -> np.ndarray:
    labels, count = ndimage.label(mask)
    if count == 0:
        return mask
    sizes = np.bincount(labels.ravel())
    keep = sizes >= minimum
    keep[0] = False
    return keep[labels]


def apply_named_mountain_ranges(
    codes: np.ndarray,
    land: np.ndarray,
    elev: np.ndarray,
    relief: np.ndarray,
    fine_relief: np.ndarray,
) -> None:
    """Make named mountain systems legible without painting artificial lines.

    Range axes only define search envelopes. DEM-supported rugged cells form the
    actual footprint, so widths vary naturally and neighboring valleys remain open.
    """
    height, width = codes.shape
    lat_grid = np.linspace(90 - 90 / height, -90 + 90 / height, height)[:, None]
    forest_codes = {"FOR", "WDH", "TGA", "CTG", "MFR", "SUB"}
    jungle_codes = {"JGL", "DRF", "DRU", "MJG", "RFM", "CLF"}
    dry_codes = {"DSR", "THN", "DPL", "CDS", "HDS", "CDM", "CDH", "RPL", "MSA", "STP", "HST", "SST"}

    for spec in NAMED_MOUNTAIN_RANGES:
        envelope = mountain_envelope_mask(width, height, spec)
        minimum_elevation = float(spec["min_elev"])
        minimum_relief = float(spec["min_relief"])
        terrain = land & envelope & (elev >= minimum_elevation)
        terrain &= (relief >= minimum_relief) | (fine_relief >= minimum_relief * 0.42)
        terrain = ndimage.binary_closing(terrain, structure=np.ones((3, 3)), iterations=1)
        terrain &= land & envelope & (elev >= minimum_elevation * 0.85)
        terrain = remove_small_components(terrain, max(3, int(round(width / 720))))
        if not terrain.any():
            continue

        original = codes.copy()
        forest = np.isin(original, list(forest_codes))
        jungle = np.isin(original, list(jungle_codes))
        dry = np.isin(original, list(dry_codes))
        profile = spec.get("profile", "source")

        lower = terrain & (elev < 1100)
        if profile == "temperate_wet":
            codes[lower] = "WDH"
        else:
            codes[lower & forest] = "WDH"
            codes[lower & jungle] = "DRU"
            codes[lower & dry] = "HST"

        montane = terrain & (elev >= 1100) & (elev < 1800)
        if profile == "temperate_wet":
            codes[montane] = "MFR"
        else:
            codes[montane & forest] = "MFR"
            codes[montane & jungle] = "RFM"
            codes[montane & dry] = "CDM"
            codes[montane & ~(forest | jungle | dry)] = "ALG"

        codes[terrain & (elev >= 1800) & (elev < 2800)] = "MTN"
        codes[terrain & (elev >= 2800) & (elev < 3600)] = "ARK"
        high_rock = terrain & (elev >= 3600) & (elev < 4500)
        codes[high_rock & dry] = "HRK"
        codes[high_rock & ~dry] = "SNM"
        codes[terrain & (elev >= 4500) & (elev < 5500)] = "HMT"
        codes[terrain & (elev >= 5500) & (elev < 6500)] = "PSN"
        codes[terrain & (elev >= 6500)] = "XPK"

        # At high latitudes, snow and glacier bands occur lower, but they still
        # require a rugged DEM-supported mountain footprint.
        polar_rugged = terrain & (np.abs(lat_grid) >= 55) & (relief >= 650)
        codes[polar_rugged & (elev >= 2200) & (elev < 3600)] = "SNM"
        codes[polar_rugged & (elev >= 3600)] = "HGL"


def apply_region(codes: np.ndarray, land: np.ndarray, coords: list[tuple[float, float]], code: str, replace: set[str] | None = None, blur: float = 1.6) -> None:
    mask = polygon_mask(codes.shape[1], codes.shape[0], coords, blur=blur)
    mask &= land
    if replace:
        mask &= np.isin(codes, list(replace))
    codes[mask] = code


def choose_by_elevation(candidates: list[str], elev: float, relief_value: float, lat: float) -> str:
    """Choose the biome whose documented elevation is closest, while respecting relief.

    This is the core rule: recipe/ecoregion gives the candidate family, DEM elevation
    decides the actual biome within that family. It prevents broad regions from being
    painted as high mountains unless DEM supports that altitude.
    """
    if elev < 0:
        elev = 0
    filtered = candidates
    if relief_value < 350:
        non_peak = [code for code in candidates if BIOMES[code]["relief"] in {"flat", "rolling"}]
        if non_peak:
            filtered = non_peak
    elif relief_value < 900:
        non_peak = [code for code in candidates if BIOMES[code]["relief"] != "peak"]
        if non_peak:
            filtered = non_peak
    # At high latitude, snow/ice line is lower, so snow-cap candidates should not
    # be penalized as heavily by their nominal mountain anchor.
    def score(code: str) -> float:
        target = BIOMES[code]["elevation"]
        adjusted = target
        if code in {"SNM", "PSN", "HGL", "GLC"} and abs(lat) >= 50:
            adjusted -= 900
        if code in {"SNM", "PSN", "HGL", "GLC"} and abs(lat) >= 65:
            adjusted -= 1600
        return abs(elev - adjusted)
    return min(filtered, key=score)


def candidate_family(code: str, lat: float) -> list[str] | None:
    if code in {"OCN", "SHF", "DPO", "TRN", "BCH", "TWN", "VOL"}:
        return None
    if code == "MNG":
        return ["MNG"]
    if code in {"ICE", "IDM", "IFD", "GLC", "HGL"}:
        if abs(lat) >= 60:
            return ["ICE", "IFD", "GLC", "IDM", "SNM"]
        return ["IFD", "GLC", "HGL", "SNM", "PSN"]
    if code in {"SNW", "TND", "PLR"}:
        return ["PLR", "TND", "SNW", "ALT", "AFF", "ARK", "SNM"]
    if code in {"JGL", "MJG", "RFM", "CLF"}:
        return ["JGL", "MJG", "RFM", "CLF", "ALG", "ARK", "HMT", "PSN"]
    if code in {"DRF", "DRU"}:
        return ["DRF", "DRU", "ALG", "ARK", "HMT"]
    if code in {"FOR", "WDH", "MFR", "SUB"}:
        return ["FOR", "WDH", "MFR", "SUB", "ALG", "ARK", "SNM", "GLC"]
    if code in {"TGA", "CTG"}:
        return ["TGA", "CTG", "SUB", "ALT", "SNM", "GLC"]
    if code == "PLT":
        return ["PLT", "ALG", "AFF", "CHL"]
    if code in {"PLN", "MDW"}:
        return [code]
    if code in {"SAV", "SVH"}:
        return ["SAV", "SVH", "ALG", "ARK", "HMT"]
    if code == "SHR":
        return ["SHR", "WDH", "MFR", "ALG", "ARK"]
    if code in {"STP", "HST", "SST"}:
        return ["STP", "HST", "SST", "ALG", "AFF", "CHL"]
    if code == "THN":
        return ["THN", "SVH", "HST"]
    if code == "DSR":
        return ["DSR", "HDS", "CDM", "CDH", "CHL"]
    if code == "CDS":
        return ["CDS", "HDS", "CDM", "CDH", "CHL", "HRK"]
    if code == "DPL":
        return ["DPL", "HDS", "CDM", "CDH", "CHL"]
    if code == "HDS":
        return ["HDS", "CDM", "CDH", "CHL", "HRK"]
    if code in {"CDM", "CDH"}:
        return ["CDM", "CDH", "CHL", "HRK"]
    if code == "RPL":
        return ["RPL", "CDM", "CDH", "HRK"]
    if code == "MSA":
        return ["MSA", "HDS", "CDM", "HRK"]
    if code in {"SLT", "DEP"}:
        return [code]
    if code in {"MSA", "RPL", "MTN", "ARK", "HRK", "ALG", "ALT", "SNM", "AFF", "CHL", "HMT", "PSN", "XPK", "HIM"}:
        return ["MTN", "ALG", "ARK", "ALT", "HRK", "CHL", "HMT", "HGL", "PSN", "XPK", "HIM"]
    if code in {"WET", "MOR"}:
        return ["WET", "MOR"]
    if code == "ISL":
        return ["ISL", "JGL", "MJG", "RFM"]
    return None


def enforce_absolute_elevation(codes: np.ndarray, land: np.ndarray, dem: np.ndarray, relief: np.ndarray) -> None:
    height, width = codes.shape
    for y in range(height):
        lat = 90 - (y + 0.5) / height * 180
        for x in range(width):
            if not land[y, x]:
                continue
            code = str(codes[y, x])
            candidates = candidate_family(code, lat)
            if not candidates:
                continue
            elev = float(dem[y, x]) if np.isfinite(dem[y, x]) else BIOMES[code]["elevation"]
            if code == "HIM":
                # HIM is only valid where either DEM is truly extreme or the final
                # named-peak pass sets it. Broad recipe polygons must be downgraded.
                if elev < 6200:
                    candidates = ["ARK", "HRK", "HGL", "HMT", "PSN", "XPK"]
            if code in {"WDH", "MFR", "SUB"} and relief[y, x] >= 350:
                candidates = ["WDH", "MFR", "SUB", "ALG", "ARK", "ALT", "SNM", "GLC"]
            selected = choose_by_elevation(candidates, elev, float(relief[y, x]), lat)
            current_elev = BIOMES[code]["elevation"]
            selected_elev = BIOMES[selected]["elevation"]
            # If the current code already matches the DEM within a reasonable band,
            # keep it to preserve vegetation geography. Otherwise enforce the anchor.
            tolerance = 450 if selected_elev < 2000 else 700
            if abs(elev - current_elev) > tolerance or abs(elev - selected_elev) + 150 < abs(elev - current_elev):
                codes[y, x] = selected


def place_named_peak(
    codes: np.ndarray,
    land: np.ndarray,
    elev: np.ndarray,
    relief: np.ndarray,
    lon: float,
    lat: float,
    search_radius: float,
    code: str,
) -> None:
    """Place one DEM-supported peak cell without circular stamping."""
    height, width = codes.shape
    cx, cy = lonlat_to_xy(lon, lat, width, height)
    radius = max(1, int(round(search_radius / 360 * width)))
    y0, y1 = max(0, cy - radius), min(height, cy + radius + 1)
    x0, x1 = max(0, cx - radius), min(width, cx + radius + 1)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    distance = np.hypot(xx - cx, yy - cy)
    candidates = land[y0:y1, x0:x1] & (distance <= radius)
    if not candidates.any():
        return
    score = elev[y0:y1, x0:x1] + relief[y0:y1, x0:x1] * 0.35 - distance * 80
    score = np.where(candidates, score, -np.inf)
    py, px = np.unravel_index(int(np.argmax(score)), score.shape)
    codes[y0 + py, x0 + px] = code


def naturalize_raster_steps(
    codes: np.ndarray,
    valid: np.ndarray,
    allowed_codes: set[str],
    seed: int,
) -> None:
    """Break long sampled source-data steps without moving a boundary over one cell."""
    max_run = max(3, int(round(codes.shape[1] / 256 * 3)))
    rng = np.random.default_rng(seed)

    def process(array: np.ndarray, valid: np.ndarray) -> None:
        snapshot = array.copy()
        for y in range(array.shape[0] - 1):
            start = 0
            previous = None
            runs = []
            for x in range(array.shape[1] + 1):
                if (
                    x < array.shape[1]
                    and valid[y, x]
                    and valid[y + 1, x]
                    and snapshot[y, x] != snapshot[y + 1, x]
                    and snapshot[y, x] in allowed_codes
                    and snapshot[y + 1, x] in allowed_codes
                ):
                    pair = (snapshot[y, x], snapshot[y + 1, x])
                else:
                    pair = None
                if pair != previous:
                    if previous is not None and x - start > max_run:
                        runs.append((start, x, previous))
                    start = x
                    previous = pair
            for start, end, pair in runs:
                cursor = start
                extend_upper = bool(rng.integers(0, 2))
                while cursor < end:
                    length = int(rng.integers(max(2, max_run // 3), max_run + 1))
                    stop = min(end, cursor + length)
                    if extend_upper:
                        array[y + 1, cursor:stop] = pair[0]
                    else:
                        array[y, cursor:stop] = pair[1]
                    extend_upper = not extend_upper
                    cursor = stop

    for _ in range(2):
        process(codes, valid)
        process(codes.T, valid.T)


def apply_dem_and_recipes(codes: np.ndarray, land_mask: Image.Image, dem: np.ndarray) -> None:
    land = np.array(land_mask) > 0
    height, width = codes.shape
    lat = np.linspace(90 - 90 / height, -90 + 90 / height, height)[:, None]
    elev = np.where(np.isfinite(dem), dem, 0)
    local_max = ndimage.maximum_filter(elev, size=7, mode="nearest")
    local_min = ndimage.minimum_filter(elev, size=7, mode="nearest")
    relief = local_max - local_min
    fine_relief = ndimage.maximum_filter(elev, size=3, mode="nearest") - ndimage.minimum_filter(
        elev, size=3, mode="nearest"
    )

    # Ocean by bathymetry. A small low-frequency perturbation prevents a sampled
    # ETOPO contour from becoming a long horizontal raster step while preserving
    # the underlying depth class at continental scale.
    water = ~land
    bath_rng = np.random.default_rng(20260713)
    bath_noise = ndimage.gaussian_filter(
        bath_rng.random(codes.shape), sigma=max(2.0, width / 240), mode="wrap"
    )
    bath_noise = (bath_noise - bath_noise.mean()) / max(float(bath_noise.std()), 1e-6)
    deep_depth = dem + bath_noise * 100
    shelf_depth = dem + bath_noise * 30
    codes[water & (deep_depth < -6500)] = "TRN"
    codes[water & (deep_depth >= -6500) & (deep_depth < -1200)] = "DPO"
    codes[water & (deep_depth >= -1200) & (shelf_depth < -180)] = "OCN"
    codes[water & (shelf_depth >= -180)] = "SHF"
    naturalize_raster_steps(codes, water, {"TRN", "DPO", "OCN", "SHF"}, 20260714)

    # Polar caps / Antarctica ice dome. The former fixed latitude bands created
    # a continent-wide horizontal seam at 75°S. Interior distance now determines
    # the dome, following the actual coastline with a low-frequency irregular edge.
    antarctica = land & (lat < -60)
    antarctic_interior = ndimage.distance_transform_edt(antarctica)
    rng = np.random.default_rng(20260712)
    dome_noise = ndimage.gaussian_filter(
        rng.random(codes.shape), sigma=max(3.0, width / 72), mode="wrap"
    )
    dome_noise = (dome_noise - dome_noise.mean()) / max(float(dome_noise.std()), 1e-6)
    dome_threshold = width / 48 + dome_noise * (width / 360)
    codes[antarctica] = "ICE"
    codes[antarctica & (antarctic_interior >= dome_threshold)] = "IDM"

    dry = np.isin(codes, ["DSR", "CDS", "DPL", "HDS", "CDM", "CDH", "RPL", "MSA", "STP", "HST", "SST", "THN"])
    forest = np.isin(codes, ["FOR", "WDH", "MFR", "TGA", "CTG", "SUB"])
    jungle = np.isin(codes, ["JGL", "DRF", "DRU", "MJG", "RFM", "CLF"])
    grass = np.isin(codes, ["PLN", "MDW", "SAV", "SHR", "STP", "PLT", "SVH", "HST", "SST"])

    # DEM-derived topography, deliberately conservative: broad plateaus stay plateau/desert,
    # sharp high relief becomes mountain/rock/snow.
    high = land & (elev > 4400)
    codes[high & dry] = "CHL"
    codes[high & ~dry] = "HMT"
    codes[land & (elev > 5600)] = "PSN"
    codes[land & (elev > 6500)] = "XPK"
    rugged_high = land & (elev > 1800) & (relief > 900)
    codes[rugged_high & forest] = "SUB"
    codes[rugged_high & jungle] = "CLF"
    codes[rugged_high & dry] = "CDM"
    codes[rugged_high & grass] = "ALG"
    codes[land & (elev > 2400) & (relief > 1250)] = "ARK"
    codes[land & (elev > 3400) & (relief > 1200) & dry] = "HRK"

    # §6 recipe overlays. These are not rectangular boxes; they are coarse geographic
    # polygons following real ranges/basins, applied after ecoregions to force named regions.
    apply_region(codes, land, [(78, 33), (86, 34.5), (96, 34), (103, 31), (101, 28), (92, 29), (82, 30), (76, 31)], "CHL", {"HST", "SST", "CDM", "CDH", "HDS", "DPL", "PLT", "ALG", "MTN"}, 1.6)
    apply_region(codes, land, [(75, 41), (82, 42), (90, 40), (90, 37), (82, 36), (76, 37)], "CDS", {"DSR", "HDS", "DPL", "STP", "HST"}, 1.2)
    apply_region(codes, land, [(92, 44), (104, 46), (116, 44), (114, 40), (101, 39), (91, 41)], "CDS", {"STP", "HST", "DPL", "HDS", "RPL", "PLN"}, 1.8)
    apply_region(codes, land, [(96, 48), (105, 49), (116, 47), (116, 43), (104, 42), (94, 44)], "HST", {"STP", "PLN", "CDS", "DPL", "FOR"}, 1.8)

    # North America: Rockies, Sierra/Cascades, Great Plains, SW deserts.
    apply_region(codes, land, [(-126, 61), (-118, 57), (-112, 49), (-106, 41), (-104, 35), (-109, 31), (-116, 39), (-124, 50), (-132, 58)], "MFR", {"FOR", "TGA", "STP", "PLN", "WDH", "SUB"}, 1.8)
    apply_region(codes, land, [(-116, 36), (-111, 35), (-108, 38), (-109, 41), (-114, 40)], "MSA", {"DSR", "DPL", "HDS", "STP", "RPL"}, 1.0)
    apply_region(codes, land, [(-122, 36), (-117, 34), (-114, 31), (-109, 29), (-104, 31), (-105, 36), (-113, 38)], "DSR", {"STP", "SAV", "SHR", "DPL", "RPL", "PLN"}, 1.5)
    apply_region(codes, land, [(-106, 49), (-97, 49), (-96, 30), (-104, 28), (-108, 39)], "STP", {"PLN", "FOR", "SAV", "SHR"}, 2.2)
    high_plains = polygon_mask(
        width,
        height,
        [(-104.8, 49), (-100.0, 49), (-99.0, 30), (-102.0, 28), (-104.8, 39)],
        blur=1.0,
    )
    high_plains &= land & (elev >= 650) & (elev <= 1800) & (fine_relief <= 1000)
    high_plains &= np.isin(codes, ["STP", "PLN", "HST"])
    codes[high_plains] = "PLT"

    # Andes plateaus. Rugged mountain cells are added later from the DEM-supported
    # named-range pass; broad recipe polygons must never paint mountain belts.
    apply_region(codes, land, [(-72, -15), (-66, -15), (-63, -24), (-66, -28), (-71, -26)], "CHL", {"HMT", "HST", "CDS", "CDM", "CDH", "STP", "DSR"}, 1.2)
    apply_region(codes, land, [(-72, -28), (-68, -28), (-67, -18), (-70, -17), (-73, -22)], "CDH", {"CHL", "HDS", "CDS", "DSR", "HST"}, 1.1)

    # Europe / West Asia.
    apply_region(codes, land, [(31, 39), (38, 41), (44, 39), (41, 36), (33, 37)], "HST", {"STP", "DPL", "SHR", "FOR"}, 1.3)
    apply_region(codes, land, [(45, 34), (57, 35), (64, 31), (60, 27), (51, 29)], "DPL", {"CDS", "DSR", "STP", "RPL", "HDS"}, 1.4)

    # Africa.
    apply_region(codes, land, [(-18, 15), (-9, 14), (0, 13), (10, 12), (20, 12.5), (30, 14), (36, 17), (34, 19), (20, 17), (5, 16), (-10, 18)], "THN", {"SAV", "DRF", "PLN"}, 1.4)
    apply_region(codes, land, [(32, 14), (41, 13), (44, 8), (40, 4), (34, 6)], "PLT", {"SAV", "DRF", "FOR", "HST", "SVH"}, 1.3)
    apply_region(codes, land, [(34, 10), (41, 9), (43, 3), (39, -4), (35, -2)], "SVH", {"SAV", "PLT", "DRF", "JGL"}, 1.3)
    apply_region(codes, land, [(20, -32), (29, -31), (31, -25), (26, -22), (20, -25)], "HST", {"SAV", "DSR", "THN", "STP"}, 1.4)
    apply_region(codes, land, [(13, -30), (18, -29), (17, -21), (13, -22)], "DSR", {"RPL", "THN", "SAV", "SHR"}, 1.0)

    # Australia / Oceania.
    apply_region(codes, land, [(116, -20), (126, -18), (139, -21), (144, -27), (139, -33), (126, -33), (116, -29)], "DSR", {"SAV", "THN", "STP", "PLN", "RPL"}, 2.1)

    # Tropical montane forests.
    apply_region(codes, land, [(-78, 9), (-72, 6), (-70, -6), (-74, -13), (-78, -4)], "CLF", {"JGL", "MJG", "RFM", "HMT"}, 1.3)
    apply_region(codes, land, [(95, 24), (105, 22), (108, 14), (104, 10), (98, 16)], "CLF", {"JGL", "DRF", "MJG", "RFM", "MFR"}, 1.2)
    apply_region(codes, land, [(135, -7), (146, -7), (147, -2), (139, 0), (133, -3)], "CLF", {"JGL", "MJG", "RFM", "FOR"}, 1.0)

    # Wetlands and mangroves from recipe, applied near coasts/large basins.
    apply_region(codes, land, [(-61, -20), (-54, -19), (-53, -15), (-58, -13), (-63, -15)], "WET", {"SAV", "JGL", "DRF", "PLN"}, 1.1)
    apply_region(codes, land, [(87, 24.8), (88, 25.4), (89.2, 24.7), (90.2, 25.2), (91.1, 24.5), (92, 25), (92.2, 23.2), (91.6, 21.2), (90.1, 20.5), (88.7, 20.1), (87.8, 21.6)], "WET", {"DRF", "JGL", "PLN", "MNG"}, 0.9)
    apply_region(codes, land, [(29, 8), (34, 8), (35, 4), (31, 3)], "WET", {"SAV", "JGL", "PLN"}, 1.0)

    # Global named-range pass. Unlike the broad recipe polygons above, this pass
    # uses each mountain axis only as a search envelope and follows DEM terrain.
    apply_named_mountain_ranges(codes, land, elev, relief, fine_relief)

    # Absolute elevation pass. §6 decides regional candidate families; DEM and
    # documented biome elevation decide the actual code.
    enforce_absolute_elevation(codes, land, elev, relief)

    # Re-assert named highest peaks as one DEM-supported cell. The previous
    # radius stamps created conspicuous white circles and are prohibited.
    for lon, lat, search_radius, code in [
        (86.9, 28.0, 1.2, "HIM"),
        (76.5, 35.9, 1.3, "XPK"),
        (69.0, -32.7, 1.1, "XPK"),
        (-151.0, 63.1, 1.1, "XPK"),
        (37.4, 3.1, 0.9, "PSN"),
        (42.4, 43.3, 0.8, "PSN"),
        (87.0, 43.0, 0.9, "HGL"),
    ]:
        place_named_peak(codes, land, elev, relief, lon, lat, search_radius, code)


def add_glaciers_and_lakes(codes: np.ndarray, land_mask: Image.Image, dem: np.ndarray) -> None:
    img = image_from_code_array(codes)
    draw_polygons(img, GLACIERS, "GLC", max_scalerank=7)
    # Large lakes/inland seas are water, but still mapped as OCN; shelf/deep are only ocean.
    draw_polygons(img, LAKES, "OCN", max_scalerank=6)
    updated = code_array_from_image(img)
    land = np.array(land_mask) > 0
    glacier = np.isin(updated, ["GLC"])
    water = np.isin(updated, ["OCN"]) & land
    yy = np.arange(codes.shape[0])[:, None]
    lat = 90 - (yy + 0.5) / codes.shape[0] * 180
    filled_dem = np.where(np.isfinite(dem), dem, 0)
    relief = (
        ndimage.maximum_filter(filled_dem, size=5, mode="nearest")
        - ndimage.minimum_filter(filled_dem, size=5, mode="nearest")
    )
    polar_glacier = glacier & land & (np.abs(lat) >= 60)
    nonpolar_glacier = glacier & land & ~polar_glacier
    preserve_peak = np.isin(codes, ["PSN", "XPK", "HIM"])
    high_nonpolar = nonpolar_glacier & (dem > 4000) & ~preserve_peak
    ordinary_nonpolar = nonpolar_glacier & ~high_nonpolar & ~preserve_peak
    codes[polar_glacier & (filled_dem < 850)] = "ICE"
    codes[polar_glacier & (filled_dem >= 850) & (filled_dem < 2350)] = "IFD"
    codes[polar_glacier & (filled_dem >= 2350)] = "IDM"
    rugged_threshold = np.where(lat >= 0, 300, 450)
    rugged_polar = polar_glacier & (filled_dem >= 900) & (filled_dem < 2850)
    rugged_polar &= relief >= rugged_threshold
    snowy_polar = polar_glacier & (filled_dem >= 2700) & (relief >= 450)
    codes[rugged_polar] = "GLC"
    codes[snowy_polar] = "SNM"
    codes[high_nonpolar] = "HGL"
    codes[ordinary_nonpolar] = "GLC"
    codes[water] = "OCN"
    naturalize_raster_steps(
        codes,
        land,
        {"PLR", "SNW", "TND", "ICE", "IFD", "GLC", "IDM", "SNM", "HGL"},
        20260715,
    )


def correct_landmark_biomes(
    codes: np.ndarray,
    source_codes: np.ndarray,
    land_mask: Image.Image,
    dem: np.ndarray,
) -> None:
    land = np.array(land_mask) > 0
    fine_relief = ndimage.maximum_filter(dem, size=3, mode="nearest") - ndimage.minimum_filter(
        dem, size=3, mode="nearest"
    )

    # Tibetan Plateau: preserve a broad, high and comparatively level roof
    # between the Himalaya/Karakoram and Kunlun mountain rims.
    tibet = polygon_mask(
        codes.shape[1],
        codes.shape[0],
        [(78, 32.5), (83, 34), (90, 34.5), (98, 33.5), (101, 31), (96, 29.7), (89, 30.2), (82, 30.5)],
        blur=0.8,
    )
    tibet_flat = tibet & land & (dem >= 3200) & (fine_relief <= 1800)
    tibet_replace = np.isin(
        codes,
        ["HST", "SST", "HDS", "CDM", "CDH", "CHL", "MTN", "ARK", "HRK", "SNM", "HGL", "HMT", "PSN"],
    )
    codes[tibet_flat & tibet_replace & (dem >= 3800)] = "CHL"
    codes[tibet_flat & tibet_replace & (dem < 3800)] = "CDH"

    # Altiplano: two Andean ridges surround a dry, high and relatively level
    # plateau. Keep glaciers/rugged peaks, flatten only the DEM-supported interior.
    altiplano = polygon_mask(
        codes.shape[1],
        codes.shape[0],
        [(-70.5, -14), (-67.2, -14.5), (-65.5, -19), (-66.3, -24), (-69.5, -24), (-71, -20)],
        blur=0.6,
    )
    altiplano_flat = altiplano & land & (dem >= 2800) & (fine_relief <= 1300)
    altiplano_replace = np.isin(
        codes,
        ["SAV", "SVH", "HST", "SST", "HDS", "CDM", "CDH", "CHL", "MTN", "ARK", "HRK", "SNM", "HMT"],
    )
    codes[altiplano_flat & altiplano_replace & (dem >= 3400)] = "CHL"
    codes[altiplano_flat & altiplano_replace & (dem < 3400)] = "HST"

    # Iceland is mostly treeless tundra and barren highland, not wooded hills.
    iceland = polygon_mask(
        codes.shape[1], codes.shape[0], [(-25, 63), (-22, 67), (-14, 67), (-12, 64), (-18, 62.5)], blur=0.4
    ) & land
    iceland_replace = iceland & np.isin(codes, ["PLN", "FOR", "WDH", "TGA", "CTG", "MFR", "SUB", "STP"])
    codes[iceland_replace & (dem < 700)] = "TND"
    codes[iceland_replace & (dem >= 700)] = "PLR"

    # New Zealand: retain glaciers and high snowy summits, but return broad
    # low/mid-elevation snowfields to temperate forest and montane vegetation.
    new_zealand = polygon_mask(
        codes.shape[1], codes.shape[0], [(165, -48), (178, -48), (179, -34), (166, -34)], blur=0.0
    ) & land
    nz_cold = new_zealand & np.isin(codes, ["SNW", "TND", "PLR", "ICE"])
    source_forest = np.isin(source_codes, ["FOR", "WDH", "MFR", "SUB", "JGL", "DRF", "DRU", "MJG", "RFM", "CLF"])
    source_grass = np.isin(source_codes, ["PLN", "SAV", "SHR", "STP", "PLT", "SVH", "HST", "SST"])
    codes[nz_cold & (dem < 900) & source_forest] = "FOR"
    codes[nz_cold & (dem < 900) & source_grass] = "PLN"
    codes[nz_cold & (dem < 900) & ~(source_forest | source_grass)] = "WDH"
    codes[nz_cold & (dem >= 900) & (dem < 1600)] = "MFR"
    codes[nz_cold & (dem >= 1600)] = "SNM"

    # Serengeti/Mara plains: keep isolated high massifs, but broad low and middle
    # elevations between them are savanna rather than a continuous mountain block.
    serengeti = polygon_mask(
        codes.shape[1],
        codes.shape[0],
        [(32, -4.5), (35, -4.5), (37, -2), (36.5, 0.5), (34, 1.2), (31.8, -0.5)],
        blur=0.7,
    ) & land
    serengeti_replace = serengeti & (dem < 1800) & np.isin(
        codes,
        ["MTN", "ARK", "CLF", "RFM", "MJG", "MOR", "IFD", "HST", "SST", "PLT", "DPL"],
    )
    codes[serengeti_replace & (dem < 1000)] = "SAV"
    codes[serengeti_replace & (dem >= 1000) & (dem < 1600)] = "SVH"
    codes[serengeti_replace & (dem >= 1600)] = "HST"

    # Tarim Basin: correct forest-family leakage on the arid basin floor while
    # preserving the DEM-derived Tianshan and Kunlun mountain rims.
    tarim = polygon_mask(
        codes.shape[1], codes.shape[0], [(75, 41), (82, 42), (90, 40), (90, 37), (82, 36), (76, 37)], blur=0.5
    ) & land & (dem <= 2200)
    tarim_forest = tarim & np.isin(codes, ["FOR", "WDH", "TGA", "CTG", "MFR", "SUB"])
    codes[tarim_forest & (dem < 1300)] = "CDS"
    codes[tarim_forest & (dem >= 1300)] = "HDS"
    tarim_east = polygon_mask(
        codes.shape[1], codes.shape[0], [(84, 41.5), (90.5, 41), (91, 38), (85, 37.2)], blur=0.3
    ) & land & (dem <= 2200)
    tarim_east_forest = tarim_east & np.isin(codes, ["FOR", "WDH", "TGA", "CTG", "MFR", "SUB"])
    codes[tarim_east_forest & (dem < 1300)] = "CDS"
    codes[tarim_east_forest & (dem >= 1300)] = "HDS"

    # Qaidam Basin: isolate the enclosed high, arid basin floor from the
    # surrounding Kunlun/Qilian mountain rims.
    qaidam_floor = polygon_mask(
        codes.shape[1], codes.shape[0], [(91.5, 38), (94, 38.6), (97.5, 37.5), (97, 36), (94, 35.8), (92, 36.5)], blur=0.3
    ) & land & (dem <= 3400)
    qaidam_alpine = qaidam_floor & np.isin(codes, ["ALT", "ARK", "HRK", "HGL", "HMT", "SNM", "PSN", "IFD", "GLC"])
    codes[qaidam_alpine & (dem < 2400)] = "HDS"
    codes[qaidam_alpine & (dem >= 2400) & (dem < 3000)] = "CDM"
    codes[qaidam_alpine & (dem >= 3000)] = "CDH"

    # Great Basin: broad low/mid-elevation glacier patches are geographically
    # invalid at this scale. Keep genuinely high snowy summits outside this mask.
    great_basin = polygon_mask(
        codes.shape[1], codes.shape[0], [(-120.5, 42.5), (-114, 42), (-112.5, 37), (-115.5, 35), (-120, 37.5)], blur=0.5
    ) & land & (dem < 3600)
    basin_glacier = great_basin & np.isin(codes, ["GLC", "IFD", "HGL"])
    codes[basin_glacier & (dem < 1400)] = "CDS"
    codes[basin_glacier & (dem >= 1400) & (dem < 2400)] = "HDS"
    codes[basin_glacier & (dem >= 2400)] = "CDM"

    # Mojave Desert is a hot to temperate high desert, not a cold-desert belt.
    mojave = polygon_mask(
        codes.shape[1], codes.shape[0], [(-119, 37), (-115, 37.5), (-113, 35), (-114.5, 33), (-118, 34)], blur=0.4
    ) & land & (dem < 2400)
    mojave_cold = mojave & (codes == "CDS")
    codes[mojave_cold & (dem < 1100)] = "DSR"
    codes[mojave_cold & (dem >= 1100)] = "HDS"

    # West Siberian Lowland: peatlands form irregular complexes within taiga,
    # not a uniform geometric stamp.
    west_siberia = polygon_mask(
        codes.shape[1], codes.shape[0], [(60, 66), (72, 68), (84, 64), (86, 55), (75, 52), (62, 55)], blur=0.8
    ) & land & (dem <= 300) & (fine_relief <= 500)
    wet_source = np.isin(codes, ["FOR", "TGA", "CTG", "PLN", "WET", "MOR"])
    wet_rng = np.random.default_rng(20260718)
    wet_seed = wet_rng.random(codes.shape)
    wet_noise = (
        ndimage.gaussian_filter(wet_seed, sigma=(2.2, 8.0), mode="wrap") * 0.55
        + ndimage.gaussian_filter(wet_seed, sigma=(6.0, 2.5), mode="wrap") * 0.45
    )
    wet_values = wet_noise[west_siberia & wet_source]
    if wet_values.size:
        wet_cutoff = float(np.quantile(wet_values, 0.58))
        wetland = west_siberia & wet_source & (wet_noise >= wet_cutoff)
        codes[wetland & (dem <= 120)] = "WET"
        codes[wetland & (dem > 120)] = "MOR"

    # Southwestern Madagascar is spiny thicket and dry scrub, not an open
    # Sahara-style desert. Preserve the western dry forest and eastern rainforest.
    madagascar_southwest = polygon_mask(
        codes.shape[1],
        codes.shape[0],
        [(42.8, -26), (46.8, -26), (47.2, -20), (44.5, -18), (43, -21)],
        blur=0.4,
    ) & land & (dem < 900)
    codes[madagascar_southwest & (codes == "DSR")] = "THN"


def earth_cell_area_rows_km2(width: int, height: int) -> np.ndarray:
    radius_km = 6371.0088
    latitude_edges = np.radians(np.linspace(90.0, -90.0, height + 1))
    longitude_width = 2 * math.pi / width
    return (
        radius_km**2
        * longitude_width
        * np.abs(np.sin(latitude_edges[:-1]) - np.sin(latitude_edges[1:]))
    )


def enforce_tibetan_glacier_area(
    codes: np.ndarray,
    land: np.ndarray,
    dem: np.ndarray,
    target_km2: float = TIBETAN_GLACIER_TARGET_KM2,
) -> dict[str, float | int]:
    height, width = codes.shape
    domain = polygon_mask(
        width,
        height,
        [
            (67, 40), (73, 42), (85, 43), (96, 42), (104, 39),
            (105, 33), (101, 27), (95, 26), (86, 27), (78, 30),
            (71, 32), (67, 36),
        ],
        blur=0.0,
    ) & land
    glacier_codes = {"GLC", "HGL"}
    original = domain & np.isin(codes, list(glacier_codes))
    fine_relief = ndimage.maximum_filter(dem, size=3, mode="nearest") - ndimage.minimum_filter(
        dem, size=3, mode="nearest"
    )
    eligible = original & np.isfinite(dem) & (dem >= 4000) & (fine_relief >= 250)

    replacement_codes = {
        "SST", "HST", "CDM", "CDH", "CHL", "AFF", "ALT",
        "MTN", "ARK", "HRK", "HMT",
    }
    replacement = domain & np.isin(codes, list(replacement_codes))
    replacement &= ~original
    if replacement.any() and original.any():
        _, nearest = ndimage.distance_transform_edt(~replacement, return_indices=True)
        codes[original] = codes[nearest[0][original], nearest[1][original]]
    else:
        codes[original] = "CHL"

    ys, xs = np.where(eligible)
    row_areas = earth_cell_area_rows_km2(width, height)
    if not xs.size:
        return {
            "candidate_cells": int(original.sum()),
            "selected_cells": 0,
            "before_km2": float(row_areas[np.where(original)[0]].sum()),
            "after_km2": 0.0,
            "target_km2": target_km2,
            "glc_cells": 0,
        }

    latitude = 90.0 - (ys + 0.5) / height * 180.0
    longitude = (xs + 0.5) / width * 360.0 - 180.0
    neighbor_count = ndimage.convolve(
        eligible.astype(np.int16), np.ones((3, 3), dtype=np.int16), mode="constant"
    )[ys, xs]
    score = dem[ys, xs] + fine_relief[ys, xs] * 0.35 + neighbor_count * 180
    tile_x = np.floor((longitude - 67) / 2.0).astype(int)
    tile_y = np.floor((latitude - 26) / 2.0).astype(int)
    tile_representatives: list[int] = []
    for tile in sorted(set(zip(tile_x.tolist(), tile_y.tolist()))):
        members = np.where((tile_x == tile[0]) & (tile_y == tile[1]))[0]
        tile_representatives.append(int(members[np.argmax(score[members])]))
    representative_set = set(tile_representatives)
    ordered = sorted(tile_representatives, key=lambda index: score[index], reverse=True)
    ordered.extend(
        index
        for index in np.argsort(score)[::-1].tolist()
        if index not in representative_set
    )

    selected = np.zeros(codes.shape, dtype=bool)
    selected_area = 0.0
    for index in ordered:
        area = float(row_areas[ys[index]])
        if selected_area >= target_km2 and abs(selected_area - target_km2) <= abs(
            selected_area + area - target_km2
        ):
            break
        selected[ys[index], xs[index]] = True
        selected_area += area
    codes[selected] = "HGL"
    return {
        "candidate_cells": int(original.sum()),
        "selected_cells": int(selected.sum()),
        "before_km2": float(row_areas[np.where(original)[0]].sum()),
        "after_km2": selected_area,
        "target_km2": target_km2,
        "glc_cells": int((domain & (codes == "GLC")).sum()),
    }


def enforce_resized_tibetan_glacier_area(
    source_codes: np.ndarray,
    resized_codes: np.ndarray,
    target_km2: float = TIBETAN_GLACIER_TARGET_KM2,
) -> dict[str, float | int]:
    source_mask = np.isin(source_codes, ["HGL"])
    coverage = np.asarray(
        Image.fromarray(source_mask.astype(np.uint8) * 255, "L").resize(
            (resized_codes.shape[1], resized_codes.shape[0]), Image.Resampling.BOX
        ),
        dtype=np.float64,
    ) / 255.0
    height, width = resized_codes.shape
    domain = polygon_mask(
        width,
        height,
        [
            (67, 40), (73, 42), (85, 43), (96, 42), (104, 39),
            (105, 33), (101, 27), (95, 26), (86, 27), (78, 30),
            (71, 32), (67, 36),
        ],
        blur=0.0,
    )
    existing = domain & np.isin(resized_codes, ["GLC", "HGL"])
    replacement_codes = {
        "SST", "HST", "CDM", "CDH", "CHL", "AFF", "ALT",
        "MTN", "ARK", "HRK", "HMT",
    }
    replacement = domain & np.isin(resized_codes, list(replacement_codes)) & ~existing
    if replacement.any() and existing.any():
        _, nearest = ndimage.distance_transform_edt(~replacement, return_indices=True)
        resized_codes[existing] = resized_codes[nearest[0][existing], nearest[1][existing]]
    else:
        resized_codes[existing] = "CHL"

    candidates = domain & (coverage > 0)
    ys, xs = np.where(candidates)
    row_areas = earth_cell_area_rows_km2(width, height)
    order = np.argsort(coverage[ys, xs])[::-1]
    selected = np.zeros(resized_codes.shape, dtype=bool)
    selected_area = 0.0
    for index in order:
        area = float(row_areas[ys[index]])
        if selected_area >= target_km2 and abs(selected_area - target_km2) <= abs(
            selected_area + area - target_km2
        ):
            break
        selected[ys[index], xs[index]] = True
        selected_area += area
    resized_codes[selected] = "HGL"
    return {
        "selected_cells": int(selected.sum()),
        "after_km2": selected_area,
        "glc_cells": int((domain & (resized_codes == "GLC")).sum()),
    }


def add_volcanoes(codes: np.ndarray, land_mask: Image.Image, dem: np.ndarray) -> None:
    land = np.array(land_mask) > 0
    height, width = codes.shape
    replace_codes = {
        "MTN", "ARK", "HRK", "HMT", "SNM", "PSN", "JGL", "MJG", "RFM",
        "CLF", "FOR", "MFR", "SUB", "SAV", "DRF", "ISL",
    }
    candidates_by_cell: dict[tuple[int, int], float] = {}
    with open(VOLCANO_CSV, newline="", encoding="latin1") as file:
        for row in csv.DictReader(file):
            try:
                lat = float(row["Latitude"])
                lon = float(row["Longitude"])
                elev = float(row.get("Elevation") or row.get("Elev") or 0)
            except Exception:
                continue
            cx, cy = lonlat_to_xy(lon, lat, width, height)
            radius = max(1, int(round(0.6 / 360 * width)))
            y0, y1 = max(0, cy - radius), min(height, cy + radius + 1)
            x0, x1 = max(0, cx - radius), min(width, cx + radius + 1)
            yy, xx = np.mgrid[y0:y1, x0:x1]
            distance = np.hypot(xx - cx, yy - cy)
            candidates = land[y0:y1, x0:x1] & np.isin(codes[y0:y1, x0:x1], list(replace_codes))
            if not candidates.any():
                continue
            score = dem[y0:y1, x0:x1] - distance * 120
            score = np.where(candidates, score, -np.inf)
            py, px = np.unravel_index(int(np.argmax(score)), score.shape)
            point = (y0 + py, x0 + px)
            candidates_by_cell[point] = max(candidates_by_cell.get(point, -np.inf), elev)

    occupied = np.zeros(codes.shape, dtype=bool)
    for (y, x), _ in sorted(candidates_by_cell.items(), key=lambda item: item[1], reverse=True):
        y0, y1 = max(0, y - 1), min(height, y + 2)
        x0, x1 = max(0, x - 1), min(width, x + 2)
        if occupied[y0:y1, x0:x1].any():
            continue
        codes[y, x] = "VOL"
        occupied[y, x] = True


def add_coast_biomes(
    codes: np.ndarray,
    source_codes: np.ndarray,
    land_mask: Image.Image,
    dem: np.ndarray,
) -> None:
    land = np.array(land_mask) > 0
    water = ~land
    adjacent_water = ndimage.binary_dilation(water, structure=np.ones((3, 3)), iterations=1) & land
    mangrove = land & (source_codes == "MNG")
    codes[mangrove] = "MNG"

    # Beach plan C: continuous major sandy coasts. Water is excluded from the
    # relief window so an ocean depth jump is not mistaken for a coastal cliff.
    land_elevation = np.where(land & np.isfinite(dem), dem, 0.0)
    local_high = ndimage.maximum_filter(np.where(land, land_elevation, -1e9), size=3, mode="nearest")
    local_low = ndimage.minimum_filter(np.where(land, land_elevation, 1e9), size=3, mode="nearest")
    coastal_relief = local_high - local_low
    coastal_relief[~np.isfinite(coastal_relief) | (coastal_relief > 1e8)] = 0
    height, width = codes.shape
    lat = np.linspace(90 - 90 / height, -90 + 90 / height, height)[:, None]
    beach_cover = np.isin(
        codes,
        ["PLN", "SAV", "STP", "SHR", "DSR", "THN", "DRF", "FOR", "JGL", "ISL"],
    )
    candidates = adjacent_water & beach_cover
    candidates &= land_elevation <= 250
    candidates &= coastal_relief <= 350
    candidates &= np.abs(lat) < 65
    candidates &= ~np.isin(codes, ["WET", "MOR", "MNG", "TND", "ICE", "IFD", "GLC"])

    # A fixed, low-frequency random field selects long natural sections instead
    # of independent pixels. The fine field varies segment ends without noise.
    rng = np.random.default_rng(20260711)
    coarse = ndimage.gaussian_filter(rng.random(codes.shape), sigma=max(2.0, width / 180), mode="wrap")
    fine = ndimage.gaussian_filter(rng.random(codes.shape), sigma=max(1.0, width / 720), mode="wrap")
    field = coarse * 0.78 + fine * 0.22
    if candidates.any():
        threshold = float(np.quantile(field[candidates], 0.42))
        beach = candidates & (field >= threshold)
    else:
        beach = np.zeros(codes.shape, dtype=bool)

    # Bridge one-cell gaps along suitable coasts, then remove isolated decorative
    # dots. Single-cell tropical islands may remain entirely beach.
    neighbor_kernel = np.ones((3, 3), dtype=np.uint8)
    neighbor_kernel[1, 1] = 0
    for _ in range(2):
        neighbors = ndimage.convolve(beach.astype(np.uint8), neighbor_kernel, mode="constant")
        beach |= candidates & (neighbors >= 2)
    labels, component_count = ndimage.label(beach, structure=np.ones((3, 3), dtype=np.uint8))
    if component_count:
        sizes = np.bincount(labels.ravel())
        keep = sizes >= 2
        keep[0] = False
        beach = keep[labels] | (beach & (codes == "ISL"))
    codes[beach] = "BCH"


def biome_elevation_band(code: str) -> tuple[float, float]:
    elevation = BIOMES[code]["elevation"]
    if code == "WET":
        return -100, 650
    if code == "MJG":
        return 100, 1800
    if elevation < 0:
        return elevation - 500, elevation + 500
    if elevation <= 50:
        return -100, 350
    if elevation <= 500:
        return -100, 950
    if elevation <= 1000:
        return 250, 1800
    if elevation <= 1500:
        return 600, 2500
    if elevation <= 2200:
        return 1200, 3300
    if elevation <= 3200:
        return 2000, 4400
    if elevation <= 4200:
        return 2900, 5400
    if elevation <= 5500:
        return 4000, 6500
    if elevation <= 6800:
        return 5400, 7600
    return 7300, 9200


def documented_setting_matches(
    code: str,
    source_code: str,
    lat: float,
    elevation: float,
    relief_value: float,
    adjacent_water: bool,
) -> tuple[bool, tuple[str, ...]]:
    if code == "OCN":
        return True, ("Natural Earth湖沼",)
    if code in {"SHF", "DPO", "TRN"}:
        return False, ("陸上監査域に海洋バイオーム",)
    if code == "BCH":
        return adjacent_water, (() if adjacent_water else ("海岸に接していない",))
    if code == "MNG":
        valid = source_code == "MNG"
        return valid, (() if valid else ("熱帯湿潤海岸条件を満たさない",))
    if code == "VOL":
        return True, ("火山データベース",)
    if code == "DEP":
        valid = elevation < -50 and BIOMES[source_code]["humidity"] != "wet"
        return valid, (() if valid else ("海面下乾燥盆地条件を満たさない",))
    if code == "WET":
        valid = elevation <= 650 and source_code in {"WET", "MOR"}
        return valid, (() if valid else ("低地湿地の標高・WWF湿地系列条件外",))
    if code == "ICE":
        valid = abs(lat) >= 60 and elevation <= 2200
        return valid, (() if valid else ("極地の低標高氷床条件外",))
    if code == "IDM":
        valid = abs(lat) >= 65 and elevation >= 1800
        return valid, (() if valid else ("極地内陸の高氷冠条件外",))
    if code in {"IFD", "GLC", "HGL"}:
        low, high = biome_elevation_band(code)
        valid = (code in {"IFD", "GLC"} and abs(lat) >= 50) or low <= elevation <= high
        return valid, (() if valid else ("氷雪の緯度・標高条件外",))

    evaluated_elevation = elevation
    evaluated_relief = relief_value
    if -500 < elevation < 0 and BIOMES[source_code]["humidity"] == "wet":
        evaluated_elevation = 0
        evaluated_relief = min(relief_value, 300)
    low, high = biome_elevation_band(code)
    if code == "ALT":
        treeline_floor = 3800 if abs(lat) < 35 else 2800 if abs(lat) < 50 else 1800
        low = max(low, treeline_floor)
    elevation_ok = low <= evaluated_elevation <= high
    relief_type = BIOMES[code]["relief"]
    relief_ok = (
        (relief_type == "flat" and evaluated_relief <= 1000)
        or (relief_type == "rolling" and evaluated_relief <= 1600)
        or (relief_type == "rugged" and evaluated_relief >= 180)
        or (relief_type == "peak" and evaluated_relief >= 500)
    )
    source_family = candidate_family(source_code, lat) or [source_code]
    if (
        code in source_family
        and elevation_ok
        and relief_type in {"flat", "rolling"}
        and evaluated_relief <= 2000
        and BIOMES[code]["category"] not in {"mountain", "alpine"}
        and BIOMES[code]["category"] == BIOMES[source_code]["category"]
    ):
        relief_ok = True
    if (
        code == source_code
        and elevation_ok
        and BIOMES[code]["category"] in {"arid", "wetland"}
        and relief_type in {"flat", "rolling"}
    ):
        relief_ok = True
    if (
        code in source_family
        and elevation_ok
        and evaluated_elevation < 600
        and BIOMES[code]["category"] == "arid"
        and BIOMES[source_code]["category"] == "arid"
    ):
        relief_ok = True
    if (
        code == source_code
        and elevation_ok
        and evaluated_elevation < 1000
        and BIOMES[code]["category"] == "grassland"
        and relief_type in {"flat", "rolling"}
    ):
        relief_ok = True
    if (
        code in source_family
        and elevation_ok
        and evaluated_elevation < 600
        and BIOMES[code]["category"] == "grassland"
        and BIOMES[source_code]["category"] == "grassland"
    ):
        relief_ok = True
    temp = BIOMES[code]["temp"]
    temp_ok = (
        (temp == "hot" and (abs(lat) <= 35 or (abs(lat) <= 45 and evaluated_elevation <= 500)))
        or (temp == "cold" and (abs(lat) >= 35 or evaluated_elevation >= 1000))
        or (temp == "temperate" and abs(lat) <= 68 and evaluated_elevation <= 4200)
    )
    topography_override = (
        code in {"MTN", "ARK", "HRK", "ALG", "ALT", "AFF", "CHL", "HMT", "SNM", "PSN", "XPK", "HIM"}
        and evaluated_elevation >= 1200
        and evaluated_relief >= 500
    )
    cover_ok = (
        code == source_code
        or code in source_family
        or topography_override
        or (
            BIOMES[code]["category"] == BIOMES[source_code]["category"]
            and BIOMES[code]["humidity"] == BIOMES[source_code]["humidity"]
        )
    )
    if code == "RPL" and source_code != "RPL" and BIOMES[source_code]["category"] != "arid":
        cover_ok = False
    if code == "PLT" and source_code != "PLT":
        cover_ok = False
    failures = []
    if not elevation_ok:
        failures.append("文書の標高帯外")
    if not relief_ok:
        failures.append("文書の起伏条件外")
    if not temp_ok:
        failures.append("文書の気温区分外")
    if not cover_ok:
        failures.append("WWF被覆と不一致")
    return not failures, tuple(failures)


def recipe_replacement(
    allowed: set[str],
    forbidden: set[str],
    source_code: str,
    lat: float,
    elevation: float,
    relief_value: float,
    adjacent_water: bool,
    strict_allowed: bool = False,
) -> str:
    source_family = set(candidate_family(source_code, lat) or [source_code])
    excluded = {"TWN", "OCN", "SHF", "DPO", "TRN", "BCH", "MNG", "VOL", "ISL"}

    def score(code: str) -> float:
        biome = BIOMES[code]
        value = abs(elevation - biome["elevation"])
        if code in source_family:
            value -= 650
        if biome["category"] == BIOMES[source_code]["category"]:
            value -= 250
        if biome["temp"] == BIOMES[source_code]["temp"]:
            value -= 120
        if biome["humidity"] == BIOMES[source_code]["humidity"]:
            value -= 120
        relief_type = biome["relief"]
        if relief_type == "flat" and relief_value > 1000:
            value += 1800
        elif relief_type == "rolling" and relief_value > 1600:
            value += 1600
        elif relief_type == "rugged" and relief_value < 180:
            value += 1800
        elif relief_type == "peak" and relief_value < 500:
            value += 2500
        return value

    candidates = (
        set(allowed) - excluded - forbidden
        if strict_allowed
        else (((set(allowed) | source_family | {source_code}) - excluded) | {source_code}) - forbidden
    )
    matching = [
        code
        for code in candidates
        if documented_setting_matches(
            code, source_code, lat, elevation, relief_value, adjacent_water
        )[0]
    ]
    if not matching and not strict_allowed:
        matching = [
            code
            for code in BIOMES
            if code not in excluded and code not in forbidden
            and documented_setting_matches(
                code, source_code, lat, elevation, relief_value, adjacent_water
            )[0]
        ]
    if not matching:
        # A coarse output cell can average elevation so strongly that no biome
        # satisfies every documented constraint. In that case remain inside the
        # regional recipe instead of falling back to an invalid source-family code.
        recipe_fallback = (set(allowed) - excluded - forbidden) or candidates
        return min(recipe_fallback, key=score)
    return min(matching, key=score)


def enforce_global_special_geography(
    codes: np.ndarray,
    source_codes: np.ndarray,
    land_mask: Image.Image,
    dem: np.ndarray,
) -> Counter:
    land = np.array(land_mask) > 0
    water = ~land
    adjacent_water = ndimage.binary_dilation(water, structure=np.ones((3, 3)), iterations=1) & land
    local_max = ndimage.maximum_filter(dem, size=3, mode="nearest")
    local_min = ndimage.minimum_filter(dem, size=3, mode="nearest")
    relief = local_max - local_min
    explicit_plateau = polygon_mask(
        codes.shape[1], codes.shape[0], [(32, 14), (41, 13), (44, 8), (40, 4), (34, 6)], blur=0.0
    ) & land
    explicit_plateau |= (
        polygon_mask(
            codes.shape[1],
            codes.shape[0],
            [(-104.8, 49), (-100.0, 49), (-99.0, 30), (-102.0, 28), (-104.8, 39)],
            blur=0.0,
        )
        & land
        & (dem >= 650)
        & (dem <= 1800)
        & (relief <= 1000)
    )
    explicit_wetland = np.zeros(codes.shape, dtype=bool)
    for coords in [
        [(-61, -20), (-54, -19), (-53, -15), (-58, -13), (-63, -15)],
        [(87, 24.8), (88, 25.4), (89.2, 24.7), (90.2, 25.2), (91.1, 24.5), (92, 25), (92.2, 23.2), (91.6, 21.2), (90.1, 20.5), (88.7, 20.1), (87.8, 21.6)],
        [(29, 8), (34, 8), (35, 4), (31, 3)],
        [(60, 66), (72, 68), (84, 64), (86, 55), (75, 52), (62, 55)],
    ]:
        explicit_wetland |= polygon_mask(codes.shape[1], codes.shape[0], coords, blur=0.0) & land

    corrections = Counter()
    ys, xs = np.where(land & np.isin(codes, ["ALT", "RPL", "PLT", "WET", "MNG"]))
    for y, x in zip(ys, xs):
        code = str(codes[y, x])
        source_code = str(source_codes[y, x])
        lat = 90 - (y + 0.5) / codes.shape[0] * 180
        elevation = float(dem[y, x]) if np.isfinite(dem[y, x]) else float(BIOMES[code]["elevation"])
        relief_value = float(relief[y, x])
        reason = None
        if code == "ALT":
            matches, failures = documented_setting_matches(
                code, source_code, lat, elevation, relief_value, bool(adjacent_water[y, x])
            )
            if not matches:
                reason = "・".join(failures)
        elif code == "RPL":
            matches, failures = documented_setting_matches(
                code, source_code, lat, elevation, relief_value, bool(adjacent_water[y, x])
            )
            if not matches:
                reason = "・".join(failures)
        elif code == "PLT":
            low, high = biome_elevation_band(code)
            explicit_match = explicit_plateau[y, x] and low <= elevation <= high and relief_value <= 1600
            if source_code != "PLT" and not explicit_match:
                reason = "明示的な高原地形ではない"
        elif code == "WET":
            if elevation > 650:
                reason = "低地湿地の標高上限650mを超える"
            elif source_code not in {"WET", "MOR"} and not explicit_wetland[y, x]:
                reason = "WWF湿地または§6の明示的大湿地に該当しない"
        elif code == "MNG":
            if source_code != "MNG":
                reason = "WWFマングローブ域に該当しない"
        if reason is None:
            continue
        allowed = set(candidate_family(source_code, lat) or [source_code])
        replacement = recipe_replacement(
            allowed,
            {code},
            source_code,
            lat,
            elevation,
            relief_value,
            bool(adjacent_water[y, x]),
        )
        if replacement == code:
            raise RuntimeError(
                f"全球重点監査で不適合セルを置換できません: ({x},{y}) {code} / {reason}"
            )
        codes[y, x] = replacement
        corrections[(code, replacement, reason)] += 1
    return corrections


def audit_and_correct_recipe_external(
    codes: np.ndarray,
    source_codes: np.ndarray,
    land_mask: Image.Image,
    dem: np.ndarray,
) -> dict[str, Counter]:
    land = np.array(land_mask) > 0
    water = ~land
    adjacent_water = ndimage.binary_dilation(water, structure=np.ones((3, 3)), iterations=1) & land
    local_max = ndimage.maximum_filter(dem, size=3, mode="nearest")
    local_min = ndimage.minimum_filter(dem, size=3, mode="nearest")
    relief = local_max - local_min
    corrections: dict[str, Counter] = {monitor["name"]: Counter() for monitor in RECIPE_MONITORS}
    monitor_masks = []
    for monitor in RECIPE_MONITORS:
        mask = polygon_mask(codes.shape[1], codes.shape[0], monitor["coords"], blur=0.0) & land
        if "min_elevation" in monitor:
            mask &= dem >= monitor["min_elevation"]
        if "max_elevation" in monitor:
            mask &= dem <= monitor["max_elevation"]
        if "max_relief" in monitor:
            mask &= relief <= monitor["max_relief"]
        monitor_masks.append(mask)
    monitored = np.logical_or.reduce(monitor_masks)
    ys, xs = np.where(monitored)
    for y, x in zip(ys, xs):
        memberships = [index for index, mask in enumerate(monitor_masks) if mask[y, x]]
        code = str(codes[y, x])
        external_memberships = [
            index for index in memberships if code not in RECIPE_MONITORS[index]["allowed"]
        ]
        if not external_memberships:
            continue
        source_code = str(source_codes[y, x])
        lat = 90 - (y + 0.5) / codes.shape[0] * 180
        elevation = float(dem[y, x]) if np.isfinite(dem[y, x]) else float(BIOMES[code]["elevation"])
        matches, failures = documented_setting_matches(
            code,
            source_code,
            lat,
            elevation,
            float(relief[y, x]),
            bool(adjacent_water[y, x]),
        )
        forbidden = set().union(
            *(RECIPE_MONITORS[index].get("forbidden_external", set()) for index in memberships)
        )
        if code in forbidden:
            matches = False
            failures = tuple(failures) + ("地域固有の地形・植生と不一致",)
        if matches:
            continue
        replacement_overrides = [
            RECIPE_MONITORS[index]["replacement_allowed"]
            for index in memberships
            if "replacement_allowed" in RECIPE_MONITORS[index]
        ]
        allowed = (
            set.intersection(*(set(values) for values in replacement_overrides))
            if replacement_overrides
            else set().union(*(RECIPE_MONITORS[index]["allowed"] for index in memberships))
        )
        replacement = recipe_replacement(
            allowed,
            forbidden,
            source_code,
            lat,
            elevation,
            float(relief[y, x]),
            bool(adjacent_water[y, x]),
            strict_allowed=bool(replacement_overrides),
        )
        codes[y, x] = replacement
        for index in external_memberships:
            monitor_name = RECIPE_MONITORS[index]["name"]
            corrections[monitor_name][(code, replacement, "・".join(failures))] += 1

    invalid_remaining = []
    for index, monitor in enumerate(RECIPE_MONITORS):
        ys, xs = np.where(monitor_masks[index] & ~np.isin(codes, list(monitor["allowed"])))
        for y, x in zip(ys, xs):
            code = str(codes[y, x])
            source_code = str(source_codes[y, x])
            lat = 90 - (y + 0.5) / codes.shape[0] * 180
            elevation = float(dem[y, x]) if np.isfinite(dem[y, x]) else float(BIOMES[code]["elevation"])
            matches, failures = documented_setting_matches(
                code,
                source_code,
                lat,
                elevation,
                float(relief[y, x]),
                bool(adjacent_water[y, x]),
            )
            if code in monitor.get("forbidden_external", set()):
                matches = False
                failures = tuple(failures) + ("地域固有の地形・植生と不一致",)
            if not matches:
                invalid_remaining.append((monitor["name"], x, y, code, failures))
    if invalid_remaining:
        sample = ", ".join(
            f"{name}({x},{y})={code}:{'/'.join(failures)}"
            for name, x, y, code, failures in invalid_remaining[:8]
        )
        raise RuntimeError(f"レシピ外監査後も不適合セルが残っています: {sample}")
    return corrections


def recipe_external_reason(
    code: str,
    mask: np.ndarray,
    source_codes: np.ndarray,
    dem: np.ndarray,
    relief: np.ndarray,
) -> str:
    if code == "OCN":
        return "Natural Earthの湖沼・内海形状に一致するため"
    if code == "BCH":
        return "海岸隣接セルで、文書の浜（標高5m・平坦）条件に一致するため"
    if code == "MNG":
        return "熱帯の湿潤海岸で、文書のマングローブ条件に一致するため"
    if code == "VOL":
        return "Smithsonian火山データベースの火山座標に一致するため"
    if code in {"GLC", "IFD", "HGL", "ICE", "IDM"}:
        return "Natural Earth氷河形状またはETOPO標高と、文書の緯度・標高別氷雪条件に一致するため"

    values = dem[mask]
    values = values[np.isfinite(values)]
    relief_values = relief[mask]
    sources = Counter(source_codes[mask].ravel())
    source_text = "、".join(f"{BIOMES[source]['jp']} {count / mask.sum() * 100:.0f}%" for source, count in sources.most_common(2))
    median_elevation = int(round(float(np.median(values)))) if values.size else BIOMES[code]["elevation"]
    median_relief = int(round(float(np.median(relief_values)))) if relief_values.size else 0
    return (
        f"ETOPO標高中央値{median_elevation}m・局地起伏中央値{median_relief}mが、"
        f"文書の{BIOMES[code]['jp']}（標高アンカー{BIOMES[code]['elevation']}m・"
        f"{BIOMES[code]['relief']}）と整合し、WWF被覆も主に{source_text}で適合するため"
    )


def write_recipe_external_report(
    codes: np.ndarray,
    source_codes: np.ndarray,
    land_mask: Image.Image,
    dem: np.ndarray,
    global_corrections: Counter,
    corrections: dict[str, Counter],
    path: Path,
) -> None:
    land = np.array(land_mask) > 0
    local_max = ndimage.maximum_filter(dem, size=3, mode="nearest")
    local_min = ndimage.minimum_filter(dem, size=3, mode="nearest")
    relief = local_max - local_min
    lines = [
        "# レシピ外バイオーム使用申告",
        "",
        "- 判定対象: `geo-reproduction-design.md` §6 の主要地域レシピに対応する監査ポリゴン",
        "- 採用条件: 文書の標高アンカー・起伏・気温・湿度/被覆が、ETOPO DEM・WWFエコリージョン・湖沼/氷河/火山/海岸データと一致すること",
        "- 自動却下: 上記条件に一致しないレシピ外セルは、地域レシピ内で最も地理条件に近いバイオームへ生成時に自動置換",
        "- 注意: 採用済みのレシピ外使用も、ユーザー判断で拒否・差し戻し可能",
        "",
    ]
    lines.extend(["## 全球重点監査", ""])
    if global_corrections:
        lines.extend([
            "| rejected | replacement | pixels | 却下理由 |",
            "|---|---|---:|---|",
        ])
        for (old, new, reason), value in global_corrections.most_common():
            lines.append(
                f"| `{old}` {BIOMES[old]['jp']} | `{new}` {BIOMES[new]['jp']} | {value} | {reason} |"
            )
        lines.append("")
    else:
        lines.extend(["- `ALT/RPL/PLT/WET/MNG` の全球不適合セル: なし", ""])
    for monitor in RECIPE_MONITORS:
        mask = polygon_mask(codes.shape[1], codes.shape[0], monitor["coords"], blur=0.0)
        mask &= land
        if "min_elevation" in monitor:
            mask &= dem >= monitor["min_elevation"]
        if "max_elevation" in monitor:
            mask &= dem <= monitor["max_elevation"]
        total = int(mask.sum())
        if total == 0:
            continue
        region_codes = codes[mask]
        external_codes = sorted(set(region_codes.ravel()) - set(monitor["allowed"]))
        counts = Counter(region_codes.ravel())
        lines.extend([f"## {monitor['name']}", ""])
        if external_codes:
            lines.extend([
                "### 採用したレシピ外バイオーム",
                "",
                "| code | biome | pct in region | pixels | 採用理由 |",
                "|---|---|---:|---:|---|",
            ])
            for code in external_codes:
                value = counts[code]
                code_mask = mask & (codes == code)
                lines.append(
                    f"| `{code}` | {BIOMES[code]['jp']} | {value / total * 100:.2f}% | {value} | "
                    f"{recipe_external_reason(code, code_mask, source_codes, dem, relief)} |"
                )
        else:
            lines.extend(["- 採用したレシピ外バイオーム: なし", ""])
        rejected = corrections.get(monitor["name"], Counter())
        if rejected:
            lines.extend([
                "",
                "### 自動却下して修正したバイオーム",
                "",
                "| rejected | replacement | pixels | 却下理由 |",
                "|---|---|---:|---|",
            ])
            for (old, new, reason), value in rejected.most_common():
                lines.append(
                    f"| `{old}` {BIOMES[old]['jp']} | `{new}` {BIOMES[new]['jp']} | {value} | "
                    f"{reason}。文書設定と地域の実地理が一致しないため |"
                )
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_mountain_audit_report(
    codes: np.ndarray,
    land_mask: Image.Image,
    dem: np.ndarray,
    path: Path,
) -> None:
    land = np.array(land_mask) > 0
    local_max = ndimage.maximum_filter(dem, size=7, mode="nearest")
    local_min = ndimage.minimum_filter(dem, size=7, mode="nearest")
    relief = local_max - local_min
    fine_relief = ndimage.maximum_filter(dem, size=3, mode="nearest") - ndimage.minimum_filter(
        dem, size=3, mode="nearest"
    )
    lines = [
        "# 主要山脈監査",
        "",
        "- 山脈軸は位置検索用であり、描画形状には使用しない",
        "- 実際の山岳域はETOPO標高・局地起伏を満たす不規則な面として抽出",
        "- 連続率は山岳セル最大連結成分の比率。低い値は谷・峠による自然な分断も含む",
        "",
        "| 山脈 | DEM対象px | 山岳表現px | 被覆率 | 最大連続率 | 判定 |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for spec in NAMED_MOUNTAIN_RANGES:
        envelope = mountain_envelope_mask(codes.shape[1], codes.shape[0], spec)
        evidence = land & envelope & (dem >= float(spec["min_elev"]) * 0.85)
        evidence &= (relief >= float(spec["min_relief"])) | (fine_relief >= float(spec["min_relief"]) * 0.42)
        mountain = evidence & np.isin(codes, list(MOUNTAIN_FOOTPRINT_CODES))
        evidence_count = int(evidence.sum())
        mountain_count = int(mountain.sum())
        coverage = mountain_count / evidence_count if evidence_count else 0.0
        labels, component_count = ndimage.label(mountain)
        if component_count:
            sizes = np.bincount(labels.ravel())[1:]
            continuity = float(sizes.max()) / mountain_count if mountain_count else 0.0
        else:
            continuity = 0.0
        if evidence_count < 3:
            status = "解像度限界"
        elif coverage >= 0.70 and continuity >= 0.45:
            status = "明瞭"
        elif coverage >= 0.45:
            status = "概ね明瞭"
        else:
            status = "要確認"
        lines.append(
            f"| {spec['name']} | {evidence_count} | {mountain_count} | {coverage * 100:.1f}% | "
            f"{continuity * 100:.1f}% | {status} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_beach_audit_report(
    codes: np.ndarray,
    source_codes: np.ndarray,
    land_mask: Image.Image,
    dem: np.ndarray,
    path: Path,
) -> None:
    land = np.array(land_mask) > 0
    water = ~land
    coast = ndimage.binary_dilation(water, structure=np.ones((3, 3)), iterations=1) & land
    beach = codes == "BCH"
    invalid_inland = beach & ~coast
    invalid_mangrove = beach & (source_codes == "MNG")
    labels, component_count = ndimage.label(beach, structure=np.ones((3, 3), dtype=np.uint8))
    sizes = np.bincount(labels.ravel())[1:] if component_count else np.array([], dtype=int)
    singleton_labels = np.where(sizes == 1)[0] + 1
    singleton = np.isin(labels, singleton_labels)
    invalid_singleton = singleton & (source_codes != "ISL")
    if invalid_inland.any() or invalid_mangrove.any() or invalid_singleton.any():
        raise RuntimeError(
            "浜監査違反: "
            f"内陸={int(invalid_inland.sum())}, "
            f"マングローブ={int(invalid_mangrove.sum())}, "
            f"孤立={int(invalid_singleton.sum())}"
        )
    coast_count = int(coast.sum())
    beach_count = int(beach.sum())
    land_elevation = np.where(land & np.isfinite(dem), dem, 0.0)
    local_high = ndimage.maximum_filter(np.where(land, land_elevation, -1e9), size=3, mode="nearest")
    local_low = ndimage.minimum_filter(np.where(land, land_elevation, 1e9), size=3, mode="nearest")
    coastal_relief = local_high - local_low
    coastal_relief[~np.isfinite(coastal_relief) | (coastal_relief > 1e8)] = 0
    lat = np.linspace(90 - 90 / codes.shape[0], -90 + 90 / codes.shape[0], codes.shape[0])[:, None]
    suitable_coast = coast & np.isin(
        codes,
        ["BCH", "PLN", "SAV", "STP", "SHR", "DSR", "THN", "DRF", "FOR", "JGL", "ISL"],
    )
    suitable_coast &= land_elevation <= 250
    suitable_coast &= coastal_relief <= 350
    suitable_coast &= np.abs(lat) < 65
    suitable_count = int(suitable_coast.sum())
    multi = sizes[sizes >= 2]
    lines = [
        "# 連続海浜監査",
        "",
        f"- 海岸セル: {coast_count}",
        f"- 浜セル: {beach_count} ({beach_count / coast_count * 100:.1f}% of coast)" if coast_count else "- 浜セル: 0",
        f"- 適格な低地海岸に占める浜: {beach_count / suitable_count * 100:.1f}%" if suitable_count else "- 適格な低地海岸に占める浜: 0%",
        f"- 連続区間数: {len(multi)}",
        f"- 区間長中央値: {float(np.median(multi)):.1f}px" if multi.size else "- 区間長中央値: 0px",
        f"- 最長区間: {int(multi.max())}px" if multi.size else "- 最長区間: 0px",
        "- 内陸浜違反: 0",
        "- マングローブ上書き違反: 0",
        "- 許可されない孤立1セル浜: 0",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def longest_exact_transition(
    codes: np.ndarray,
    horizontal: bool,
    include_pair,
) -> tuple[int, tuple[int, int, int, str, str] | None]:
    array = codes if horizontal else codes.T
    best: tuple[int, tuple[int, int, int, str, str] | None] = (0, None)
    for y in range(array.shape[0] - 1):
        start = 0
        previous = None
        for x in range(array.shape[1] + 1):
            if x < array.shape[1] and array[y, x] != array[y + 1, x]:
                pair = (str(array[y, x]), str(array[y + 1, x]))
                if not include_pair(*pair):
                    pair = None
            else:
                pair = None
            if pair != previous:
                if previous is not None and x - start > best[0]:
                    best = (x - start, (y, start, x - 1, previous[0], previous[1]))
                start = x
                previous = pair
    return best


def write_shape_audit_report(codes: np.ndarray, path: Path) -> None:
    max_run = max(3, int(round(codes.shape[1] / 256 * 3)))

    def noncoastal(first: str, second: str) -> bool:
        return BIOMES[first]["category"] != "coastal" and BIOMES[second]["category"] != "coastal"

    horizontal = longest_exact_transition(codes, True, noncoastal)
    vertical = longest_exact_transition(codes, False, noncoastal)
    him_count = int((codes == "HIM").sum())
    volcano_labels, volcano_components = ndimage.label(
        codes == "VOL", structure=np.ones((3, 3), dtype=np.uint8)
    )
    volcano_sizes = np.bincount(volcano_labels.ravel())[1:] if volcano_components else np.array([], dtype=int)
    largest_volcano = int(volcano_sizes.max()) if volcano_sizes.size else 0
    failures = []
    if him_count != 1:
        failures.append(f"HIMセル数={him_count}")
    if largest_volcano > 1:
        failures.append(f"火山最大連結成分={largest_volcano}")
    if horizontal[0] > max_run:
        failures.append(f"陸上水平直線={horizontal[0]}px")
    if vertical[0] > max_run:
        failures.append(f"陸上垂直直線={vertical[0]}px")
    if failures:
        raise RuntimeError("人工形状監査違反: " + "、".join(failures))
    lines = [
        "# 人工形状監査",
        "",
        "- 円形・楕円形の山頂半径スタンプ: 使用なし",
        f"- `HIM`セル: {him_count}（エベレスト相当1セルのみ）",
        f"- 火山セル: {int((codes == 'VOL').sum())}（最大連結成分 {largest_volcano}セル）",
        f"- 非海洋バイオーム水平直線最大: {horizontal[0]}px / 上限 {max_run}px",
        f"- 非海洋バイオーム垂直直線最大: {vertical[0]}px / 上限 {max_run}px",
        "- 固定緯度による極域境界: 使用なし",
        "- 判定: 合格",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def write_world_region_review(
    codes: np.ndarray,
    land_mask: Image.Image,
    path: Path,
    previous_path: Path | None = None,
) -> None:
    land = np.array(land_mask) > 0
    previous_codes = None
    if previous_path and previous_path.exists():
        previous_image = Image.open(previous_path).convert("RGB")
        if previous_image.size == (codes.shape[1], codes.shape[0]):
            previous_codes = code_array_from_image(previous_image)

    lines = [
        "# 全世界・地域別再監査",
        "",
        "- 判定は国境ではなく、山脈・平野・乾燥帯・森林帯が周辺国へ連続する広域で行う",
        "- 中核率は、その地域を説明できる主要バイオームが陸地に占める割合",
        "- 変更率は今回の再生成前画像から変わった陸地セルの割合",
        "",
        "| 地域 | 中核率 | 変更率 | 多いバイオーム | 判定 |",
        "|---|---:|---:|---|---|",
    ]
    regional_changes: list[tuple[str, float, Counter]] = []
    for review in WORLD_REGION_REVIEWS:
        mask = polygon_mask(codes.shape[1], codes.shape[0], review["coords"], blur=0.0) & land
        count = int(mask.sum())
        if not count:
            lines.append(f"| {review['name']} | - | - | 陸地セルなし | 解像度限界 |")
            continue
        values = codes[mask]
        counts = Counter(values)
        core_count = sum(counts.get(code, 0) for code in review["core"])
        core_ratio = core_count / count
        top = " / ".join(
            f"`{code}` {BIOMES[code]['jp']} {value / count * 100:.0f}%"
            for code, value in counts.most_common(4)
        )
        if previous_codes is not None:
            changed_cells = previous_codes[mask] != values
            changed_ratio = float(changed_cells.sum()) / count
            changed_text = f"{changed_ratio * 100:.1f}%"
            transitions = Counter(zip(previous_codes[mask][changed_cells], values[changed_cells]))
            regional_changes.append((review["name"], changed_ratio, transitions))
        else:
            changed_text = "比較元なし"
        status = "合格" if core_ratio >= 0.55 else "要目視確認" if core_ratio >= 0.40 else "要修正"
        lines.append(
            f"| {review['name']} | {core_ratio * 100:.1f}% | {changed_text} | {top} | {status} |"
        )

    if previous_codes is not None:
        changed = land & (previous_codes != codes)
        transitions = Counter(zip(previous_codes[changed], codes[changed]))
        lines.extend(
            [
                "",
                "## 主な全世界共通修正",
                "",
                f"- 変更した陸地セル: {int(changed.sum())} / {int(land.sum())} ({changed.sum() / land.sum() * 100:.1f}%)",
                "",
                "| 修正前 | 修正後 | セル数 |",
                "|---|---|---:|",
            ]
        )
        for (old, new), value in transitions.most_common(20):
            lines.append(
                f"| `{old}` {BIOMES[old]['jp']} | `{new}` {BIOMES[new]['jp']} | {value} |"
            )
        lines.extend(["", "## 地域ごとの主な変更", ""])
        for name, ratio, transitions in regional_changes:
            if ratio < 0.005 or not transitions:
                continue
            summary = "、".join(
                f"{BIOMES[old]['jp']}→{BIOMES[new]['jp']} {value}px"
                for (old, new), value in transitions.most_common(3)
            )
            lines.append(f"- **{name}** ({ratio * 100:.1f}%変更): {summary}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_json(codes: np.ndarray, path: Path) -> None:
    rows = ["".join(codes[y, x] for x in range(codes.shape[1])) for y in range(codes.shape[0])]
    width = int(codes.shape[1])
    height = int(codes.shape[0])
    data = {
        "width": width,
        "height": height,
        **({"size": width} if width == height else {}),
        "seed": None,
        "scheme": "map-maker-v2",
        "layer": "public",
        "source": "Blockland Map Maker / geo-reproduction generator",
        "px_means": "1px = 1 region",
        "region_blocks": 64,
        "world_width_blocks": width * 64,
        "world_height_blocks": height * 64,
        "legend": BIOMES,
        "rows": rows,
        "structures": [],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def sanitize_resized_beaches(codes: np.ndarray) -> np.ndarray:
    """Reapply beach adjacency/continuity after nearest-neighbor resizing."""
    result = codes.copy()
    water_codes = {"OCN", "SHF", "DPO", "TRN"}

    def replace(mask: np.ndarray) -> None:
        source = result.copy()
        for y, x in zip(*np.where(mask)):
            replacement = None
            for radius in (1, 2, 3):
                y0, y1 = max(0, y - radius), min(result.shape[0], y + radius + 1)
                x0, x1 = max(0, x - radius), min(result.shape[1], x + radius + 1)
                values = [
                    str(value)
                    for value in source[y0:y1, x0:x1].ravel()
                    if value != "BCH" and value not in water_codes
                ]
                if values:
                    replacement = Counter(values).most_common(1)[0][0]
                    break
            result[y, x] = replacement or "ISL"

    water = np.isin(result, list(water_codes))
    adjacent_water = ndimage.binary_dilation(water, structure=np.ones((3, 3)), iterations=1) & ~water
    replace((result == "BCH") & ~adjacent_water)

    beach = result == "BCH"
    labels, count = ndimage.label(beach, structure=np.ones((3, 3), dtype=np.uint8))
    if count:
        sizes = np.bincount(labels.ravel())
        replace(beach & np.isin(labels, np.where(sizes == 1)[0]))
    return result


def compose_panel(img: Image.Image, counts: Counter[str], title: str) -> Image.Image:
    legend_items = sorted(BIOMES.items(), key=lambda item: (item[1]["category"], item[1]["elevation"], item[0]))
    cols = 4
    row_h = 24
    panel_w = img.width
    legend_h = math.ceil(len(legend_items) / cols) * row_h + 95
    out = Image.new("RGB", (panel_w, img.height + legend_h), (246, 248, 250))
    out.paste(img, (0, 58))
    draw = ImageDraw.Draw(out)
    try:
        title_font = ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", 28)
        font = ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", 13)
        small = ImageFont.truetype("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", 11)
    except Exception:
        title_font = font = small = ImageFont.load_default()
    draw.text((18, 14), title, fill=(18, 22, 28), font=title_font)
    draw.text((18, 42), "Natural Earth + WWF Ecoregions + ETOPO DEM + §6 region recipes / fixed 3-letter 63-biome palette", fill=(60, 64, 70), font=small)
    start_y = img.height + 72
    col_w = panel_w // cols
    total = img.width * img.height
    for idx, (code, biome) in enumerate(legend_items):
        col, row = divmod(idx, math.ceil(len(legend_items) / cols))
        x = col * col_w + 16
        y = start_y + row * row_h
        draw.rectangle((x, y, x + 18, y + 14), fill=RGB[code], outline=(70, 70, 70))
        pct = counts.get(code, 0) / total * 100
        draw.text((x + 24, y - 2), f"{code} {biome['jp']} {pct:.1f}%", fill=(24, 28, 32), font=font)
    return out


def render(width: int, height: int, json_size: tuple[int, int] | None = (512, 256)) -> dict[str, Path]:
    ensure_source_data()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    land_mask = draw_shape_file_mask(COUNTRIES, width, height)
    img = render_ecoregions(width, height)
    dem = sample_dem(width, height)
    land_values = np.array(land_mask, dtype=np.uint8)
    land_values[np.isfinite(dem) & (dem < -500)] = 0
    land_mask = Image.fromarray(land_values, "L")
    codes = code_array_from_image(img)
    source_codes = codes.copy()
    apply_dem_and_recipes(codes, land_mask, dem)
    add_glaciers_and_lakes(codes, land_mask, dem)
    correct_landmark_biomes(codes, source_codes, land_mask, dem)
    add_volcanoes(codes, land_mask, dem)
    add_coast_biomes(codes, source_codes, land_mask, dem)
    global_corrections = enforce_global_special_geography(codes, source_codes, land_mask, dem)
    corrections = audit_and_correct_recipe_external(codes, source_codes, land_mask, dem)
    post_audit_global = enforce_global_special_geography(codes, source_codes, land_mask, dem)
    global_corrections.update(post_audit_global)
    if post_audit_global:
        second_pass = audit_and_correct_recipe_external(codes, source_codes, land_mask, dem)
        for region, values in second_pass.items():
            corrections[region].update(values)
    remaining_global = enforce_global_special_geography(codes, source_codes, land_mask, dem)
    # The regional audit can legitimately reintroduce one of the five globally
    # constrained codes as a recipe candidate. This last pass is authoritative:
    # it applies the global rule and records the correction instead of failing on
    # an already-corrected cell.
    global_corrections.update(remaining_global)

    land = np.array(land_mask) > 0
    polar_edge = ndimage.binary_dilation(codes == "PLR", structure=np.ones((3, 3)), iterations=1)
    polar_transition = polar_edge & land & np.isin(codes, ["FOR", "WDH", "PLN"])
    codes[polar_transition] = "TND"
    tundra_edge = ndimage.binary_dilation(codes == "TND", structure=np.ones((3, 3)), iterations=1)
    taiga_transition = tundra_edge & land & np.isin(codes, ["FOR", "WDH", "PLN"])
    codes[taiga_transition] = "CTG"
    naturalize_raster_steps(
        codes,
        land,
        {"PLR", "SNW", "TND", "CTG", "TGA", "ICE", "IFD", "GLC", "IDM", "SNM", "HGL"},
        20260717,
    )
    naturalize_raster_steps(
        codes,
        land,
        {
            "PLN", "MDW", "SAV", "SHR", "STP", "SVH", "HST", "SST",
            "FOR", "WDH", "TGA", "CTG", "MFR", "SUB",
            "JGL", "DRF", "DRU", "MJG", "RFM", "CLF",
            "DSR", "THN", "DPL", "CDS", "HDS", "CDM", "CDH",
        },
        20260716,
    )
    tibetan_glacier_report = enforce_tibetan_glacier_area(codes, land, dem)
    water = ~land
    invalid_water = water & ~np.isin(codes, ["TRN", "SHF", "OCN", "DPO"])
    codes[invalid_water] = "OCN"
    final = image_from_code_array(codes)
    borders = draw_country_borders(final)
    counts = Counter(codes.ravel())
    panel = compose_panel(borders, counts, "Geo-reproduction biome world map v1")

    no_borders_path = OUT_DIR / f"geo_biome_world_{width}x{height}.png"
    borders_path = OUT_DIR / f"geo_biome_world_borders_{width}x{height}.png"
    panel_path = OUT_DIR / f"geo_biome_world_panel_{width}x{height}.png"
    final.save(no_borders_path)
    borders.save(borders_path)
    panel.save(panel_path)

    outputs = {"no_borders": no_borders_path, "borders": borders_path, "panel": panel_path}
    resized_tibetan_glacier_report = None
    if json_size:
        jw, jh = json_size
        small = final.resize((jw, jh), Image.Resampling.NEAREST)
        small_codes = sanitize_resized_beaches(code_array_from_image(small))
        resized_tibetan_glacier_report = enforce_resized_tibetan_glacier_area(codes, small_codes)
        small = image_from_code_array(small_codes)
        json_path = OUT_DIR / f"geo_biome_world_{jw}x{jh}.json"
        json_png_path = OUT_DIR / f"geo_biome_world_{jw}x{jh}.png"
        write_json(small_codes, json_path)
        small.save(json_png_path)
        outputs["json"] = json_path
        outputs["json_png"] = json_png_path

    stats_path = OUT_DIR / f"geo_biome_world_stats_{width}x{height}.md"
    recipe_external_path = OUT_DIR / f"geo_biome_world_recipe_external_{width}x{height}.md"
    mountain_audit_path = OUT_DIR / f"geo_biome_world_mountain_audit_{width}x{height}.md"
    beach_audit_path = OUT_DIR / f"geo_biome_world_beach_audit_{width}x{height}.md"
    shape_audit_path = OUT_DIR / f"geo_biome_world_shape_audit_{width}x{height}.md"
    tibetan_glacier_audit_path = OUT_DIR / f"geo_biome_world_tibetan_glacier_audit_{width}x{height}.md"
    region_review_path = OUT_DIR / f"geo_biome_world_region_review_{width}x{height}.md"
    total = width * height
    stats_lines = [
        "# Geo Biome World Stats",
        "",
        f"- size: {width}x{height}",
        f"- land pixels: {int(land.sum())} ({land.sum() / total * 100:.1f}%)",
        f"- Tibetan glacier represented area: {tibetan_glacier_report['after_km2']:.0f} km² "
        f"(target {tibetan_glacier_report['target_km2']:.0f} km²)",
        "",
        "| code | jp | pct | pixels |",
        "|---|---|---:|---:|",
    ]
    for code, value in counts.most_common():
        stats_lines.append(f"| `{code}` | {BIOMES[code]['jp']} | {value / total * 100:.2f}% | {value} |")
    stats_path.write_text("\n".join(stats_lines) + "\n", encoding="utf-8")
    write_recipe_external_report(
        codes, source_codes, land_mask, dem, global_corrections, corrections, recipe_external_path
    )
    write_mountain_audit_report(codes, land_mask, dem, mountain_audit_path)
    write_beach_audit_report(codes, source_codes, land_mask, dem, beach_audit_path)
    write_shape_audit_report(codes, shape_audit_path)
    write_world_region_review(
        codes,
        land_mask,
        region_review_path,
        Path(f"/tmp/geo_biome_world_before_global_review.png"),
    )
    tibetan_glacier_audit_path.write_text(
        "\n".join(
            [
                "# Tibetan Glacier Audit",
                "",
                f"- target area: {tibetan_glacier_report['target_km2']:.0f} km²",
                f"- candidate raster area before correction: {tibetan_glacier_report['before_km2']:.0f} km²",
                f"- represented area after correction: {tibetan_glacier_report['after_km2']:.0f} km²",
                f"- candidate cells: {tibetan_glacier_report['candidate_cells']}",
                f"- selected HGL cells: {tibetan_glacier_report['selected_cells']}",
                f"- remaining GLC cells in Tibetan domain: {tibetan_glacier_report['glc_cells']}",
                *(
                    [
                        f"- resized selected HGL cells: {resized_tibetan_glacier_report['selected_cells']}",
                        f"- resized represented area: {resized_tibetan_glacier_report['after_km2']:.0f} km²",
                        f"- resized remaining GLC cells: {resized_tibetan_glacier_report['glc_cells']}",
                    ]
                    if resized_tibetan_glacier_report
                    else []
                ),
                "- rule: Tibetan-domain glaciers require DEM >= 4000m and rugged relief; retained cells are HGL.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    outputs["stats"] = stats_path
    outputs["recipe_external"] = recipe_external_path
    outputs["mountain_audit"] = mountain_audit_path
    outputs["beach_audit"] = beach_audit_path
    outputs["shape_audit"] = shape_audit_path
    outputs["tibetan_glacier_audit"] = tibetan_glacier_audit_path
    outputs["region_review"] = region_review_path
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--json-width", type=int, default=512)
    parser.add_argument("--json-height", type=int, default=256)
    args = parser.parse_args()
    outputs = render(args.width, args.height, (args.json_width, args.json_height))
    for key, path in outputs.items():
        print(f"{key}: {path}")


if __name__ == "__main__":
    main()
