"""Seed the stock_universe table.

Strategy: lists are EMBEDDED (snapshot of index constituents, early 2026) so
seeding always works offline — NSE/niftyindices CSV endpoints block scripted
clients unpredictably. Index composition changes a few names per year; edit
the lists below or the stock_universe table directly when constituents change.
Delisted/renamed symbols simply fail their data fetch and get skipped by the
engine — they never break a daily run.

Segments:
  NIFTY50   — the headline 50
  NEXT100   — interpreted as ranks ~51–150 (Nifty Next 50 + large midcaps)
  SMALLCAP  — liquid smallcap selection
  GOLD_ETF / SILVER_ETF

Run:  python scripts/seed_universe.py   (from project root, venv active)
"""
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DB_URL = os.environ.get("DATABASE_URL_SYNC", "postgresql://stocksage:stocksage_secret_2026@localhost:5433/stocksage")

# (symbol, company, sector) — sector uses the 9 tracked buckets
NIFTY50 = [
    ("RELIANCE.NS", "Reliance Industries", "Oil & Gas"),
    ("TCS.NS", "Tata Consultancy Services", "IT"),
    ("HDFCBANK.NS", "HDFC Bank", "Banking & Finance"),
    ("ICICIBANK.NS", "ICICI Bank", "Banking & Finance"),
    ("INFY.NS", "Infosys", "IT"),
    ("BHARTIARTL.NS", "Bharti Airtel", "Services"),
    ("ITC.NS", "ITC", "FMCG"),
    ("SBIN.NS", "State Bank of India", "Banking & Finance"),
    ("LT.NS", "Larsen & Toubro", "Manufacturing"),
    ("HCLTECH.NS", "HCL Technologies", "IT"),
    ("BAJFINANCE.NS", "Bajaj Finance", "Banking & Finance"),
    ("KOTAKBANK.NS", "Kotak Mahindra Bank", "Banking & Finance"),
    ("AXISBANK.NS", "Axis Bank", "Banking & Finance"),
    ("ASIANPAINT.NS", "Asian Paints", "Manufacturing"),
    ("MARUTI.NS", "Maruti Suzuki", "Manufacturing"),
    ("SUNPHARMA.NS", "Sun Pharmaceutical", "Pharma & Healthcare"),
    ("TITAN.NS", "Titan Company", "Services"),
    ("ULTRACEMCO.NS", "UltraTech Cement", "Manufacturing"),
    ("NTPC.NS", "NTPC", "Energy & Power"),
    ("ONGC.NS", "Oil & Natural Gas Corp", "Oil & Gas"),
    ("TATAMOTORS.NS", "Tata Motors", "Manufacturing"),
    ("WIPRO.NS", "Wipro", "IT"),
    ("M&M.NS", "Mahindra & Mahindra", "Manufacturing"),
    ("POWERGRID.NS", "Power Grid Corp", "Energy & Power"),
    ("TATASTEEL.NS", "Tata Steel", "Metal"),
    ("ADANIENT.NS", "Adani Enterprises", "Services"),
    ("ADANIPORTS.NS", "Adani Ports & SEZ", "Services"),
    ("COALINDIA.NS", "Coal India", "Energy & Power"),
    ("BAJAJFINSV.NS", "Bajaj Finserv", "Banking & Finance"),
    ("NESTLEIND.NS", "Nestle India", "FMCG"),
    ("GRASIM.NS", "Grasim Industries", "Manufacturing"),
    ("HINDALCO.NS", "Hindalco Industries", "Metal"),
    ("JSWSTEEL.NS", "JSW Steel", "Metal"),
    ("TECHM.NS", "Tech Mahindra", "IT"),
    ("INDUSINDBK.NS", "IndusInd Bank", "Banking & Finance"),
    ("DRREDDY.NS", "Dr. Reddy's Laboratories", "Pharma & Healthcare"),
    ("CIPLA.NS", "Cipla", "Pharma & Healthcare"),
    ("APOLLOHOSP.NS", "Apollo Hospitals", "Pharma & Healthcare"),
    ("EICHERMOT.NS", "Eicher Motors", "Manufacturing"),
    ("BRITANNIA.NS", "Britannia Industries", "FMCG"),
    ("TATACONSUM.NS", "Tata Consumer Products", "FMCG"),
    ("HEROMOTOCO.NS", "Hero MotoCorp", "Manufacturing"),
    ("BAJAJ-AUTO.NS", "Bajaj Auto", "Manufacturing"),
    ("SHRIRAMFIN.NS", "Shriram Finance", "Banking & Finance"),
    ("BEL.NS", "Bharat Electronics", "Manufacturing"),
    ("TRENT.NS", "Trent", "Services"),
    ("BPCL.NS", "Bharat Petroleum", "Oil & Gas"),
    ("HINDUNILVR.NS", "Hindustan Unilever", "FMCG"),
    ("SBILIFE.NS", "SBI Life Insurance", "Banking & Finance"),
    ("HDFCLIFE.NS", "HDFC Life Insurance", "Banking & Finance"),
]

NEXT100 = [
    ("LTIM.NS", "LTIMindtree", "IT"),
    ("PERSISTENT.NS", "Persistent Systems", "IT"),
    ("COFORGE.NS", "Coforge", "IT"),
    ("MPHASIS.NS", "Mphasis", "IT"),
    ("OFSS.NS", "Oracle Financial Services", "IT"),
    ("TATAELXSI.NS", "Tata Elxsi", "IT"),
    ("KPITTECH.NS", "KPIT Technologies", "IT"),
    ("LTTS.NS", "L&T Technology Services", "IT"),
    ("JIOFIN.NS", "Jio Financial Services", "Banking & Finance"),
    ("CHOLAFIN.NS", "Cholamandalam Investment", "Banking & Finance"),
    ("MUTHOOTFIN.NS", "Muthoot Finance", "Banking & Finance"),
    ("BANKBARODA.NS", "Bank of Baroda", "Banking & Finance"),
    ("PNB.NS", "Punjab National Bank", "Banking & Finance"),
    ("CANBK.NS", "Canara Bank", "Banking & Finance"),
    ("UNIONBANK.NS", "Union Bank of India", "Banking & Finance"),
    ("IDFCFIRSTB.NS", "IDFC First Bank", "Banking & Finance"),
    ("FEDERALBNK.NS", "Federal Bank", "Banking & Finance"),
    ("AUBANK.NS", "AU Small Finance Bank", "Banking & Finance"),
    ("ICICIPRULI.NS", "ICICI Prudential Life", "Banking & Finance"),
    ("ICICIGI.NS", "ICICI Lombard General Insurance", "Banking & Finance"),
    ("SBICARD.NS", "SBI Cards", "Banking & Finance"),
    ("PFC.NS", "Power Finance Corp", "Banking & Finance"),
    ("RECLTD.NS", "REC Limited", "Banking & Finance"),
    ("IRFC.NS", "Indian Railway Finance Corp", "Banking & Finance"),
    ("HDFCAMC.NS", "HDFC Asset Management", "Banking & Finance"),
    ("BSE.NS", "BSE Limited", "Banking & Finance"),
    ("MCX.NS", "Multi Commodity Exchange", "Banking & Finance"),
    ("CDSL.NS", "Central Depository Services", "Banking & Finance"),
    ("ANGELONE.NS", "Angel One", "Banking & Finance"),
    ("LICHSGFIN.NS", "LIC Housing Finance", "Banking & Finance"),
    ("PIDILITIND.NS", "Pidilite Industries", "Manufacturing"),
    ("SIEMENS.NS", "Siemens India", "Manufacturing"),
    ("ABB.NS", "ABB India", "Manufacturing"),
    ("CUMMINSIND.NS", "Cummins India", "Manufacturing"),
    ("BHARATFORG.NS", "Bharat Forge", "Manufacturing"),
    ("ASHOKLEY.NS", "Ashok Leyland", "Manufacturing"),
    ("TVSMOTOR.NS", "TVS Motor", "Manufacturing"),
    ("MOTHERSON.NS", "Samvardhana Motherson", "Manufacturing"),
    ("POLYCAB.NS", "Polycab India", "Manufacturing"),
    ("DIXON.NS", "Dixon Technologies", "Manufacturing"),
    ("VOLTAS.NS", "Voltas", "Manufacturing"),
    ("HAVELLS.NS", "Havells India", "Manufacturing"),
    ("ASTRAL.NS", "Astral", "Manufacturing"),
    ("SUPREMEIND.NS", "Supreme Industries", "Manufacturing"),
    ("APLAPOLLO.NS", "APL Apollo Tubes", "Manufacturing"),
    ("CGPOWER.NS", "CG Power & Industrial", "Manufacturing"),
    ("HAL.NS", "Hindustan Aeronautics", "Manufacturing"),
    ("BHEL.NS", "Bharat Heavy Electricals", "Manufacturing"),
    ("THERMAX.NS", "Thermax", "Manufacturing"),
    ("SRF.NS", "SRF Limited", "Manufacturing"),
    ("PIIND.NS", "PI Industries", "Manufacturing"),
    ("UPL.NS", "UPL Limited", "Manufacturing"),
    ("AMBUJACEM.NS", "Ambuja Cements", "Manufacturing"),
    ("SHREECEM.NS", "Shree Cement", "Manufacturing"),
    ("BERGEPAINT.NS", "Berger Paints", "Manufacturing"),
    ("DABUR.NS", "Dabur India", "FMCG"),
    ("GODREJCP.NS", "Godrej Consumer Products", "FMCG"),
    ("MARICO.NS", "Marico", "FMCG"),
    ("COLPAL.NS", "Colgate-Palmolive India", "FMCG"),
    ("UNITDSPR.NS", "United Spirits", "FMCG"),
    ("VBL.NS", "Varun Beverages", "FMCG"),
    ("ZYDUSLIFE.NS", "Zydus Lifesciences", "Pharma & Healthcare"),
    ("TORNTPHARM.NS", "Torrent Pharmaceuticals", "Pharma & Healthcare"),
    ("LUPIN.NS", "Lupin", "Pharma & Healthcare"),
    ("AUROPHARMA.NS", "Aurobindo Pharma", "Pharma & Healthcare"),
    ("ALKEM.NS", "Alkem Laboratories", "Pharma & Healthcare"),
    ("MANKIND.NS", "Mankind Pharma", "Pharma & Healthcare"),
    ("BIOCON.NS", "Biocon", "Pharma & Healthcare"),
    ("MAXHEALTH.NS", "Max Healthcare", "Pharma & Healthcare"),
    ("FORTIS.NS", "Fortis Healthcare", "Pharma & Healthcare"),
    ("DIVISLAB.NS", "Divi's Laboratories", "Pharma & Healthcare"),
    ("GAIL.NS", "GAIL India", "Oil & Gas"),
    ("IOC.NS", "Indian Oil Corp", "Oil & Gas"),
    ("HINDPETRO.NS", "Hindustan Petroleum", "Oil & Gas"),
    ("ADANIPOWER.NS", "Adani Power", "Energy & Power"),
    ("ADANIGREEN.NS", "Adani Green Energy", "Energy & Power"),
    ("ADANIENSOL.NS", "Adani Energy Solutions", "Energy & Power"),
    ("TATAPOWER.NS", "Tata Power", "Energy & Power"),
    ("JSWENERGY.NS", "JSW Energy", "Energy & Power"),
    ("NHPC.NS", "NHPC", "Energy & Power"),
    ("SUZLON.NS", "Suzlon Energy", "Energy & Power"),
    ("VEDL.NS", "Vedanta", "Metal"),
    ("JINDALSTEL.NS", "Jindal Steel & Power", "Metal"),
    ("SAIL.NS", "Steel Authority of India", "Metal"),
    ("NMDC.NS", "NMDC", "Metal"),
    ("DLF.NS", "DLF", "Services"),
    ("LODHA.NS", "Macrotech Developers", "Services"),
    ("GODREJPROP.NS", "Godrej Properties", "Services"),
    ("INDIGO.NS", "InterGlobe Aviation", "Services"),
    ("DMART.NS", "Avenue Supermarts", "Services"),
    ("NAUKRI.NS", "Info Edge India", "Services"),
    ("POLICYBZR.NS", "PB Fintech", "Services"),
    ("PAYTM.NS", "One97 Communications", "Services"),
    ("IRCTC.NS", "IRCTC", "Services"),
    ("CONCOR.NS", "Container Corp of India", "Services"),
    ("INDUSTOWER.NS", "Indus Towers", "Services"),
    ("TATACOMM.NS", "Tata Communications", "Services"),
    ("DELHIVERY.NS", "Delhivery", "Services"),
    ("PAGEIND.NS", "Page Industries", "Services"),
    ("BOSCHLTD.NS", "Bosch", "Manufacturing"),
]

SMALLCAP = [
    ("CYIENT.NS", "Cyient", "IT"),
    ("BSOFT.NS", "Birlasoft", "IT"),
    ("SONATSOFTW.NS", "Sonata Software", "IT"),
    ("INTELLECT.NS", "Intellect Design Arena", "IT"),
    ("TANLA.NS", "Tanla Platforms", "IT"),
    ("HAPPSTMNDS.NS", "Happiest Minds", "IT"),
    ("MASTEK.NS", "Mastek", "IT"),
    ("REDINGTON.NS", "Redington", "Services"),
    ("KARURVYSYA.NS", "Karur Vysya Bank", "Banking & Finance"),
    ("CUB.NS", "City Union Bank", "Banking & Finance"),
    ("CSBBANK.NS", "CSB Bank", "Banking & Finance"),
    ("EQUITASBNK.NS", "Equitas Small Finance Bank", "Banking & Finance"),
    ("CREDITACC.NS", "CreditAccess Grameen", "Banking & Finance"),
    ("MANAPPURAM.NS", "Manappuram Finance", "Banking & Finance"),
    ("IIFL.NS", "IIFL Finance", "Banking & Finance"),
    ("CESC.NS", "CESC", "Energy & Power"),
    ("PRAJIND.NS", "Praj Industries", "Manufacturing"),
    ("KIRLOSENG.NS", "Kirloskar Oil Engines", "Manufacturing"),
    ("ELGIEQUIP.NS", "Elgi Equipments", "Manufacturing"),
    ("KEI.NS", "KEI Industries", "Manufacturing"),
    ("AMBER.NS", "Amber Enterprises", "Manufacturing"),
    ("SYRMA.NS", "Syrma SGS Technology", "Manufacturing"),
    ("DATAPATTNS.NS", "Data Patterns", "Manufacturing"),
    ("MTARTECH.NS", "MTAR Technologies", "Manufacturing"),
    ("VGUARD.NS", "V-Guard Industries", "Manufacturing"),
    ("AARTIIND.NS", "Aarti Industries", "Manufacturing"),
    ("FINEORG.NS", "Fine Organic Industries", "Manufacturing"),
    ("GNFC.NS", "Gujarat Narmada Fertilizers", "Manufacturing"),
    ("CHAMBLFERT.NS", "Chambal Fertilisers", "Manufacturing"),
    ("RALLIS.NS", "Rallis India", "Manufacturing"),
    ("GRANULES.NS", "Granules India", "Pharma & Healthcare"),
    ("NATCOPHARM.NS", "Natco Pharma", "Pharma & Healthcare"),
    ("AJANTPHARM.NS", "Ajanta Pharma", "Pharma & Healthcare"),
    ("JBCHEPHARM.NS", "JB Chemicals & Pharma", "Pharma & Healthcare"),
    ("ERIS.NS", "Eris Lifesciences", "Pharma & Healthcare"),
    ("CAPLIPOINT.NS", "Caplin Point Laboratories", "Pharma & Healthcare"),
    ("SYNGENE.NS", "Syngene International", "Pharma & Healthcare"),
    ("LAURUSLABS.NS", "Laurus Labs", "Pharma & Healthcare"),
    ("JYOTHYLAB.NS", "Jyothy Labs", "FMCG"),
    ("EMAMILTD.NS", "Emami", "FMCG"),
    ("BIKAJI.NS", "Bikaji Foods", "FMCG"),
    ("RADICO.NS", "Radico Khaitan", "FMCG"),
    ("CCL.NS", "CCL Products", "FMCG"),
    ("BALRAMCHIN.NS", "Balrampur Chini Mills", "FMCG"),
    ("INDIAMART.NS", "IndiaMART InterMESH", "Services"),
    ("NAZARA.NS", "Nazara Technologies", "Services"),
    ("MAPMYINDIA.NS", "C.E. Info Systems (MapmyIndia)", "Services"),
    ("IRB.NS", "IRB Infrastructure", "Services"),
    ("NBCC.NS", "NBCC India", "Services"),
    ("HUDCO.NS", "HUDCO", "Banking & Finance"),
    ("RITES.NS", "RITES", "Services"),
    ("IRCON.NS", "IRCON International", "Services"),
    ("RAILTEL.NS", "RailTel Corp", "Services"),
    ("NCC.NS", "NCC Limited", "Manufacturing"),
]

ETFS = [
    ("GOLDBEES.NS", "Nippon India ETF Gold BeES", "Metal", "GOLD_ETF"),
    ("SILVERBEES.NS", "Nippon India ETF Silver BeES", "Metal", "SILVER_ETF"),
]


def seed() -> None:
    """Upsert the full universe. Safe to re-run anytime."""
    rows: list[tuple[str, str, str, str]] = []
    rows += [(s, n, sec, "NIFTY50") for s, n, sec in NIFTY50]
    rows += [(s, n, sec, "NEXT100") for s, n, sec in NEXT100]
    rows += [(s, n, sec, "SMALLCAP") for s, n, sec in SMALLCAP]
    rows += [(s, n, sec, seg) for s, n, sec, seg in ETFS]

    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    for symbol, name, sector, segment in rows:
        cur.execute(
            """
            INSERT INTO stock_universe (symbol, company_name, sector, segment, is_active)
            VALUES (%s, %s, %s, %s, TRUE)
            ON CONFLICT (symbol) DO UPDATE
            SET company_name = EXCLUDED.company_name,
                sector = EXCLUDED.sector,
                segment = EXCLUDED.segment,
                is_active = TRUE
            """,
            (symbol, name, sector, segment),
        )
    conn.commit()

    cur.execute("SELECT segment, COUNT(*) FROM stock_universe GROUP BY segment ORDER BY segment")
    print("✅ Universe seeded:")
    for seg, count in cur.fetchall():
        print(f"   {seg:<12} {count} symbols")
    cur.close()
    conn.close()


if __name__ == "__main__":
    try:
        seed()
    except psycopg2.OperationalError as exc:
        print(f"❌ Cannot reach Postgres on localhost:5433 — is Docker running? ({exc})")
        sys.exit(1)
