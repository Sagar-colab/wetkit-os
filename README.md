# WetKit OS

Production plumbing DFMA platform. Live at **https://dttradesman.ai**

Created by **Sagar U**

## What it does
- Parses BricsCAD AX-3000 single-line IFC files
- Extracts pipe segments, classifies 8 systems (CW/HW/HWR/FWS/SOIL/WASTE/VENT/SWD)
- Generates pre-fab spools (IS 2065 DFU compliant, ≤2000mm)
- Produces BOM (CPWD DSR 2023 rates, IS 1239/IS 4985/IS 15778 specs)
- Exports A4 PDF spool sheets + IFC back-export
- Tracks fabrication status (pending → confirmed → fabricated → installed)
- Phone-first tradesman PWA in 6 languages (EN/HI/KN/TA/TE/ML)

## Stack
Node.js · Express 5 · PostgreSQL 16 · Three.js · Python · PDFKit · JWT · nginx · Hetzner

## Standards
IS 2065 · IS 1239 · IS 4985 · IS 15778 · NBC Part 9 · CPWD DSR 2023 · IFC4
