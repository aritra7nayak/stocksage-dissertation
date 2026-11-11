"""Normalizes yfinance/NSE sector strings onto StockSage's 9 tracked sectors (R9)."""

TRACKED = (
    "IT", "Banking & Finance", "Manufacturing", "Services",
    "Metal", "Oil & Gas", "Energy & Power", "Pharma & Healthcare", "FMCG",
)

_YF_SECTOR_MAP: dict[str, str] = {
    "technology": "IT",
    "communication services": "Services",
    "financial services": "Banking & Finance",
    "financial": "Banking & Finance",
    "industrials": "Manufacturing",
    "consumer cyclical": "Services",
    "consumer defensive": "FMCG",
    "basic materials": "Metal",
    "energy": "Oil & Gas",
    "utilities": "Energy & Power",
    "healthcare": "Pharma & Healthcare",
    "real estate": "Services",
}

_INDUSTRY_OVERRIDES: dict[str, str] = {
    # Basic-materials names that are really manufacturing inputs, not metals
    "specialty chemicals": "Manufacturing",
    "chemicals": "Manufacturing",
    "building materials": "Manufacturing",
    "cement": "Manufacturing",
    "paints": "Manufacturing",
    "agricultural inputs": "Manufacturing",
    # Auto belongs to manufacturing, not generic 'consumer cyclical'
    "auto manufacturers": "Manufacturing",
    "auto parts": "Manufacturing",
    "farm & heavy construction machinery": "Manufacturing",
    # Power generators classified as 'energy' by Yahoo
    "utilities - independent power producers": "Energy & Power",
    "utilities - renewable": "Energy & Power",
    "thermal coal": "Energy & Power",
    "telecom services": "Services",
}


def normalize_sector(yf_sector: str | None, yf_industry: str | None = None) -> str:
    """Map a yfinance (sector, industry) pair onto one of the 9 tracked sectors.

    Industry overrides win over sector mapping. Unknown inputs fall back to
    'Services' (the broadest bucket) so nothing is ever unclassified.
    """
    industry = (yf_industry or "").strip().lower()
    if industry in _INDUSTRY_OVERRIDES:
        return _INDUSTRY_OVERRIDES[industry]
    sector = (yf_sector or "").strip().lower()
    return _YF_SECTOR_MAP.get(sector, "Services")
