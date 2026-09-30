#!/usr/bin/env python3
"""Tagesgenauen deutschen Gasverbrauch von Trading Hub Europe holen.

Quelle
------
Trading Hub Europe (THE) veroeffentlicht die aggregierten Allokationsmengen
aller Entnahmestellen im deutschen Marktgebiet je Gastag. Abruf ueber die
dokumentierte XML-Schnittstelle, ohne Zugangsschluessel:

    https://api.tradinghub.eu/api/dataexport/xmlexport/AggregatedConsumptionData
        ?startDate=yyyy-mm-dd&endDate=yyyy-mm-dd

    Doku: https://api.tradinghub.eu/api/dataexport/manual/de
    Uebersicht: https://www.tradinghub.eu/de-de/Veroeffentlichungen/Weitere-Veroeffentlichungen/
                Aggregierte-Verbrauchsdaten

Die Schnittstelle verlangt einen aussagekraeftigen User-Agent.

Rechenweg
---------
Die Antwort liefert je Gastag acht Mengen in kWh, getrennt nach Gasqualitaet
(H/L) und Abrechnungsart:

    SLP  = HGasSLPsyn + HGasSLPana + LGasSLPsyn + LGasSLPana
           Standardlastprofil-Kunden: Haushalte und kleines Gewerbe.
    RLM  = HGasRLMmT + LGasRLMmT + HGasRLMoT + LGasRLMoT
           Registrierende Leistungsmessung: Industrie und Kraftwerke.

    Verbrauch [GWh] = (SLP + RLM) / 1e6

Kontrolle gegen eine unabhaengige Quelle: fuer das Kalenderjahr 2024 ergibt
die Reihe 838,3 TWh Verbrauch bei 39,1 % SLP-Anteil. Die Bundesnetzagentur
nennt fuer dasselbe Jahr 844 TWh und 39 % Haushalts- und Gewerbekunden
gegenueber 61 % Industrie. Zwei getrennte Messwege, 0,7 % Abstand.

Ergebnis
--------
data/de_consumption_daily.csv mit einer Zeile je Gastag:
    date, consumption_gwh, slp_gwh, rlm_gwh, status, source

`status` uebernimmt die THE-Angabe (preliminary / final / corrected).
Vorhandene Zeilen werden ueberschrieben, wenn THE korrigierte Werte liefert;
--refresh-days (Vorgabe 45) legt fest, wie weit rueckwirkend erneut geholt
wird. Das ist kein Selbstzweck: im Export 2021-08-01..2026-07-31 tragen 61 von
1826 Gastagen den Status "corrected".

Die Einheit steht in jedem Datensatz selbst (<Unit>kWh</Unit>) und wird bei
jedem Abruf geprueft; ein abweichender Wert bricht den Lauf ab, statt still
falsch zu rechnen.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import sys
import tempfile
from zoneinfo import ZoneInfo
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ENDPOINT = "https://api.tradinghub.eu/api/dataexport/xmlexport/AggregatedConsumptionData"
REPORT_ID = "AggregatedConsumptionData"
NS = "{urn:schemas-microsoft-com:sql:SqlRowSet1}"
USER_AGENT = (
    "de-gas-storage-tracker-bnetza/1.0 "
    "(+https://github.com/volzinnovation/de-gas-storage-tracker-bnetza)"
)

SLP_FIELDS = ("HGasSLPsyn", "HGasSLPana", "LGasSLPsyn", "LGasSLPana")
RLM_FIELDS = ("HGasRLMmT", "LGasRLMmT", "HGasRLMoT", "LGasRLMoT")

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "data" / "de_consumption_daily.csv"
COLUMNS = ["date", "consumption_gwh", "slp_gwh", "rlm_gwh", "status", "source"]
SOURCE_LABEL = "Trading Hub Europe AggregatedConsumptionData"

# THE veroeffentlicht ab dem 1. Januar 2018.
FIRST_GASDAY = dt.date(2018, 1, 1)
# In Scheiben abrufen, damit einzelne Anfragen klein bleiben.
CHUNK_DAYS = 366
# Ein Tag Publikationsverzug plus ein Tag Toleranz fuer den Morgenlauf.
MAX_DATA_AGE_DAYS = 2


def fetch(start: dt.date, end: dt.date, timeout: int = 60) -> bytes:
    """Einen Zeitraum abrufen. Datumsformat der Schnittstelle ist yyyy-mm-dd."""
    query = (
        f"{ENDPOINT}?startDate={start.isoformat()}&endDate={end.isoformat()}"
    )
    request = urllib.request.Request(query, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def parse(payload: bytes) -> list[dict]:
    """Neues XML und alte SQL-Namespaces lesen; fehlend ist niemals Null."""
    text = payload.decode("utf-8-sig")
    marker = text.find("<AggregatedConsumptionData")
    if marker < 0:
        raise ValueError("Antwort enthaelt kein AggregatedConsumptionData-Element.")
    root = ET.fromstring(text[marker:])
    if root.tag != REPORT_ID:
        raise ValueError("Unerwartetes XML-Wurzelelement.")

    rows: list[dict] = []
    seen: set[str] = set()
    for record in root:
        namespace = NS if record.tag == f"{NS}{REPORT_ID}" else ""
        if record.tag != f"{namespace}{REPORT_ID}":
            raise ValueError(f"Unerwartetes XML-Element: {record.tag}")

        def field_text(field: str) -> str:
            nodes = record.findall(f"{namespace}{field}")
            if len(nodes) != 1 or not nodes[0].text or not nodes[0].text.strip():
                raise ValueError(f"Fehlendes, leeres oder doppeltes Feld: {field}")
            return nodes[0].text.strip()

        raw_date = field_text("Gasday")
        # Beide API-Generationen liefern ISO-Datum bzw. ISO-Zeitstempel.
        gasday = dt.datetime.fromisoformat(raw_date).date()
        date = gasday.isoformat()
        if date in seen:
            raise ValueError(f"Doppelter Gastag: {date}")
        seen.add(date)
        unit = field_text("Unit")
        if unit.lower() != "kwh":
            raise ValueError(f"{date}: Unerwartete Einheit: {unit!r} (erwartet kWh)")
        amounts = {}
        for field in SLP_FIELDS + RLM_FIELDS:
            value = field_text(field)
            if not value.isascii() or not value.isdecimal():
                raise ValueError(f"{date}: Ungueltige nichtnegative ganze Menge in {field}: {value!r}")
            amounts[field] = int(value)
        status = field_text("Status")
        if status not in {"preliminary", "final", "corrected"}:
            raise ValueError(f"{date}: Unbekannter Status: {status!r}")
        slp_kwh = sum(amounts[f] for f in SLP_FIELDS)
        rlm_kwh = sum(amounts[f] for f in RLM_FIELDS)
        rows.append({
            "date": date,
            "consumption_gwh": f"{(slp_kwh + rlm_kwh) / 1e6:.3f}",
            "slp_gwh": f"{slp_kwh / 1e6:.3f}",
            "rlm_gwh": f"{rlm_kwh / 1e6:.3f}",
            "status": status,
            "source": SOURCE_LABEL,
            # Vor Rundung pruefen: kleine positive Mengen sind keine Null.
            "_rlm_zero": rlm_kwh == 0,
        })
    return rows


def load_existing() -> dict[str, dict]:
    if not TARGET.exists():
        return {}
    with TARGET.open(newline="", encoding="utf-8") as handle:
        return {row["date"]: row for row in csv.DictReader(handle)}


def write(rows: dict[str, dict]) -> None:
    """Erst vollstaendig schreiben, dann auf demselben Dateisystem ersetzen."""
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", newline="", encoding="utf-8", dir=TARGET.parent,
            prefix=f".{TARGET.name}.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            writer = csv.DictWriter(handle, fieldnames=COLUMNS)
            writer.writeheader()
            for date in sorted(rows):
                writer.writerow({key: rows[date].get(key, "") for key in COLUMNS})
        temporary.replace(TARGET)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def today_in_berlin() -> dt.date:
    return dt.datetime.now(ZoneInfo("Europe/Berlin")).date()


def validate_coverage(rows: dict[str, dict], start: dt.date, today: dt.date,
                      max_data_age_days: int) -> None:
    """Frische und Luecken am Abruf pruefen, niemals mit Cache kaschieren."""
    if not rows:
        raise ValueError("Keine vollstaendigen Verbrauchsdaten erhalten.")
    latest = dt.date.fromisoformat(max(rows))
    required = today - dt.timedelta(days=max_data_age_days)
    if latest < required:
        raise ValueError(f"Veralteter Datenstand: {latest}; erwartet mindestens {required}.")
    day = start
    while day <= latest:
        if day.isoformat() not in rows:
            raise ValueError(f"Gastag fehlt im Abruf: {day}")
        day += dt.timedelta(days=1)


def spans(start: dt.date, end: dt.date):
    while start <= end:
        stop = min(start + dt.timedelta(days=CHUNK_DAYS - 1), end)
        yield start, stop
        start = stop + dt.timedelta(days=1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--full",
        action="store_true",
        help="komplette Historie ab 2018 neu laden statt nur der letzten Tage",
    )
    parser.add_argument(
        "--refresh-days",
        type=int,
        default=45,
        help="wie viele Tage rueckwirkend erneuert werden (Korrekturen nachziehen)",
    )
    parser.add_argument(
        "--max-data-age-days", type=int, default=MAX_DATA_AGE_DAYS,
        help="maximales Alter des letzten vollstaendigen Gastags (Vorgabe 2)",
    )
    args = parser.parse_args()
    if args.refresh_days < 1 or args.max_data_age_days < 1:
        parser.error("--refresh-days und --max-data-age-days muessen positiv sein")

    existing = load_existing()
    heute = today_in_berlin()

    if args.full or not existing:
        start = FIRST_GASDAY
    else:
        letzter = dt.date.fromisoformat(max(existing))
        start = min(letzter, heute) - dt.timedelta(days=args.refresh_days)
        start = max(start, FIRST_GASDAY)

    fetched: dict[str, dict] = {}
    provisional: set[str] = set()
    for von, bis in spans(start, heute):
        try:
            rows = parse(fetch(von, bis))
            for row in rows:
                date = row["date"]
                if not von <= dt.date.fromisoformat(date) <= bis:
                    raise ValueError(f"Gastag ausserhalb des Abrufzeitraums: {date}")
                # THE publiziert SLP fuer den Folgetag, RLM fuer den Vortag.
                # Nur heutige vorlaeufige Null-RLM-Werte sind daher noch kein
                # vollstaendiger Tagesverbrauch. Historische Nullen bleiben.
                if date == heute.isoformat() and row["status"] == "preliminary" and row["_rlm_zero"]:
                    provisional.add(date)
                    print(f"{date}: vorlaeufiger Gastag ohne RLM ausgelassen.", file=sys.stderr)
                else:
                    fetched[date] = row
        except (urllib.error.URLError, OSError, ValueError, ET.ParseError) as fehler:
            print(f"Abruf {von}..{bis} fehlgeschlagen: {fehler}", file=sys.stderr)
            return 1

    try:
        # Leere Bereiche vor Beginn der Quellhistorie sind erlaubt. Sobald
        # Historie bekannt ist, sind fehlende Tage hingegen ein Fehler.
        history = existing or fetched
        coverage_start = max(start, dt.date.fromisoformat(min(history))) if history else start
        validate_coverage(fetched, coverage_start, heute, args.max_data_age_days)
        unexplained_tail = {date for date in existing if date > max(fetched)} - provisional
        if unexplained_tail:
            raise ValueError(f"Bekannte neuere Gastage fehlen in der Quelle: {sorted(unexplained_tail)}")
        for date in provisional:
            old = existing.get(date)
            if old and (old["status"] != "preliminary" or float(old["rlm_gwh"]) != 0):
                raise ValueError(f"{date}: Vorlaeufige Meldung wuerde vorhandenen RLM-Verbrauch entfernen.")
        # Nur erfolgreich bestaetigte SLP-only Randtage alter Importversionen
        # entfernen; bei irgendeinem Fehler bleibt die Datei unveraendert.
        for date in provisional:
            existing.pop(date, None)
        existing.update(fetched)
        write(existing)
    except (OSError, ValueError) as fehler:
        print(f"Validierung/Schreiben fehlgeschlagen: {fehler}", file=sys.stderr)
        return 1
    print(
        f"{len(existing)} Gastage in {TARGET} "
        f"({min(existing)} bis {max(existing)}), {len(fetched)} Zeilen aktualisiert. "
        f"Datenalter: {(heute - dt.date.fromisoformat(max(existing))).days} Tage."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
