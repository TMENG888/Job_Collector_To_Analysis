import re
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in [item for item in archive.namelist() if item.startswith("xl/worksheets/sheet") and item.endswith(".xml")]:
        sheet = archive.read(name).decode("utf-8")
        print(name)
        for address in ["G2", "I2", "AH2"]:
            marker = f'r="{address}"'
            position = sheet.find(marker)
            print(address, sheet[max(0, position - 60):position + 220] if position >= 0 else "missing")
