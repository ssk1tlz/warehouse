# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['warehouse_tray.py'],
    pathex=[],
    binaries=[],
    datas=[('server.py', '.'), ('app.js', '.'), ('index.html', '.'), ('styles.css', '.'), ('schema.sql', '.'), ('act_generator.py', '.'), ('mobile_actions.py', '.'), ('migrations.py', '.'), ('qrcode-lib.js', '.'), ('chart.umd.min.js', '.')],
    hiddenimports=['PyQt5', 'sqlite3'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='WarehouseApp_New',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='NONE',
)
