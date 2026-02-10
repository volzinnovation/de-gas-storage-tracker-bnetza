# Projektion Gasspeicherstand Deutschland

Automatisierte Projektion des deutschen Gasspeicherstands auf Basis von Daten der Bundesnetzagentur (BNetzA).

## Letzte Projektionen

Stand aus `data/projections.csv`, letzter Lauf:

```text
Projektion #Gasspeicher DE vom 2026-02-10
Fuellstand 26.99% am 2026-02-08
Kritisches Minimum 20.0% (Entnahmerate bricht stark ein)

Szenarien - Minimum wird erreicht am:

2026-03-11
Optimistisch (20% weniger Entnahme)
(-0.224%/Tag)

2026-03-04
Kleinste Entnahme
(-0.28%/Tag)

2026-02-17
Durchschnittliche Entnahme
(-0.71%/Tag)

2026-02-14
Groesste Entnahme
(-1.04%/Tag)

2026-02-13
Pessimistisch (20% mehr Entnahme)
(-1.248%/Tag)

## Datenquellen

- `url_a`: `https://www.bundesnetzagentur.de/_tools/SVG/js2/_functions/csv_export.html?view=renderCSV&id=870304`
- `url_b`: `https://www.bundesnetzagentur.de/_tools/SVG/js2/_functions/csv_export.html?view=renderCSV&id=870306`

Der Workflow nutzt `url_b` fuer die taegliche Projektion.

## Was der Python-Job macht

Datei: `scripts/2026_gasspeicher_deutschland.py`

- laedt `url_b` herunter
- cached die Quelle nach `data/bnetza_cache.csv` (git-versionierbar)
- nutzt bei Netzwerkfehlern den Cache als Fallback
- berechnet auf Basis der letzten 30 Tage (konfigurierbar) Szenario-Raten
- berechnet fuer jedes Szenario das Datum, an dem das Minimum erreicht wird
- schreibt pro Ausfuehrung **eine neue Zeile** nach `data/projections.csv`
- gibt eine lesbare Kurzfassung in der Konsole aus

## Output-Dateien

- `data/bnetza_cache.csv`: letzter heruntergeladener Stand von `url_b`
- `data/projections.csv`: historisierte Projektionen, eine Zeile pro Lauf

Typische Spalten in `projections.csv`:

- Lauf-Metadaten (`run_timestamp_utc`, `run_date_berlin`, `data_source_mode`)
- Eingangsdaten (`latest_data_date`, `current_fill_level_pct`)
- Basis-Raten (`rate_min_pct_per_day`, `rate_avg_pct_per_day`, `rate_max_pct_per_day`)
- je Szenario:
  - `..._rate_pct_per_day`
  - `..._target_date`
  - `..._days_to_min`

## Lokale Ausfuehrung

```bash
python -m pip install pandas requests
python scripts/2026_gasspeicher_deutschland.py
```

Optionen:

```bash
python scripts/2026_gasspeicher_deutschland.py --minimum 20 --lookback-days 30
```

## GitHub Actions Automatisierung

Workflow: `.github/workflows/daily-gasspeicher-projection.yml`

- Zeitplan: taeglich `11:00 UTC` (= `12:00 GMT+1`)
- Fuehrt das Python-Skript aus
- committed geaenderte `data/bnetza_cache.csv` und `data/projections.csv` automatisch ins Repository

## Eingebaute Verbesserungen

- robustes Caching fuer `url_b` inkl. Offline-Fallback
- reproduzierbare tabellarische Historie in CSV statt nur Konsolenoutput
- CLI-Parameter fuer Minimum und Lookback-Window
- robuste Spaltenerkennung (Umlaute/Spaltenvarianten)
- automatisches Daily-Run + Versionierung der Daten ueber GitHub Actions

## Hinweise

- Der Cron-Trigger ist auf feste GMT+1-Logik ausgelegt (`11:00 UTC`).
- Wenn stattdessen strikt lokale Zeit `Europe/Berlin` mit Sommerzeit gewuenscht ist, muss der Zeitplan angepasst werden.
