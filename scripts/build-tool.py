"""Build a self-contained Windows Companion tool using installed, tested runtimes."""
from datetime import datetime, timezone
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--python', required=True, help='Python environment containing autotune dependencies')
    parser.add_argument('--release-date',default=datetime.now(timezone.utc).date().isoformat())
    parser.add_argument('--release-notes',type=Path,help='UTF-8 release notes file')
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    runtime=json.loads(subprocess.check_output([args.python,'-c','import sys,json,site;print(json.dumps({"base":sys.base_prefix,"site":site.getsitepackages()[-1]}))'],text=True))
    subprocess.run([args.python,'-c','import numpy,pandas,torch,sklearn,matplotlib,openpyxl,pydantic_settings'],check=True)
    subprocess.run(['npm.cmd','run','build'],cwd=root/'frontend',check=True)
    electron=root/'desktop/node_modules/electron/dist'
    if not (electron/'electron.exe').is_file():raise RuntimeError('Run npm ci in desktop before building.')
    version=json.loads((root/'desktop/package.json').read_text())['version']
    release=root/'release';release.mkdir(exist_ok=True)
    build=root/'build';build.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='tool-',dir=build) as tmp:
        package=Path(tmp)
        app=package/'electron/resources/app'
        print('Copying Electron and Python runtimes…',flush=True)
        shutil.copytree(electron,package/'electron')
        (package/'electron/electron.exe').rename(package/'electron/IFsAutotune.exe')
        app.mkdir(parents=True,exist_ok=True)
        (app/'package.json').write_text(json.dumps({'name':'ifs-autotune','version':version,'main':'desktop/main.js'}))
        desktop=app/'desktop';desktop.mkdir()
        for name in ['main.js','preload.js','companion-host.js','companion-bridge.js']:
            shutil.copy2(root/'desktop'/name,desktop/name)
        shutil.copytree(root/'frontend/dist',desktop/'frontend/dist')
        # Select source files explicitly, never working databases or local environments.
        files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=root,text=True).splitlines()
        for rel in sorted(set(files)):
            source=root/rel
            if not source.is_file():continue
            if (rel.startswith('backend/') and (source.suffix=='.py' or rel=='backend/tools/ParquetReaderlite.exe')) or rel.startswith('desktop/input/template/') or rel=='LICENSE':
                target=app/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
        python=app/'python';python.mkdir()
        base=Path(runtime['base'])
        for source in base.iterdir():
            if source.is_file() and (source.suffix in ('.exe','.dll') or source.name=='LICENSE.txt'):shutil.copy2(source,python/source.name)
        ignore=shutil.ignore_patterns('__pycache__','*.pyc','*.pyo','*.whl','direct_url.json','__editable*','bigpopa_backend*')
        for name in ['DLLs','Lib','tcl']:
            shutil.copytree(base/name,python/name,ignore=lambda folder,names: set(ignore(folder,names)) | ({'site-packages'} if Path(folder)==base/'Lib' else set()))
        shutil.copytree(runtime['site'],python/'Lib/site-packages',ignore=ignore)
        subprocess.run([str(python/'python.exe'),'-B','-I','-c','import numpy,pandas,torch,sklearn,matplotlib,openpyxl,pydantic_settings;print("Bundled runtime verified")'],cwd=app,check=True)
        manifest={'id':'ifs-autotune','name':'IFs Autotune','version':version,'api_version':1,'platform':'win-x64','kind':'web-service','entrypoint':'electron/IFsAutotune.exe'}
        (package/'tool.json').write_text(json.dumps(manifest,indent=2))
        (package/'README.txt').write_text('Install this .ifstool file using IFsCompanion > Settings > Manage tools.\nPython and Electron are included. No separate installation is required.\nDependency licenses are included in the Electron and Python runtime folders.\n')
        meta_path=package/'tool.json'
        meta=json.loads(meta_path.read_text(encoding='utf-8'))
        meta.update(name='Autotune',released_at=args.release_date,min_companion_version='0.1.0',release_notes=args.release_notes.read_text(encoding='utf-8') if args.release_notes else '')
        meta['installed_size']=sum(p.stat().st_size for p in package.rglob('*') if p.is_file())
        meta_path.write_text(json.dumps(meta,indent=2),encoding='utf-8')
        destination=release/f'ifs-autotune-{version}-win-x64.ifstool'
        pending=destination.with_suffix('.partial')
        print('Compressing tool package…',flush=True)
        with zipfile.ZipFile(pending,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as archive:
            for file in sorted(package.rglob('*')):
                if file.is_file() and '__pycache__' not in file.parts and file.suffix not in ('.pyc','.pyo','.whl'):archive.write(file,file.relative_to(package).as_posix())
        with zipfile.ZipFile(pending) as archive:
            if archive.testzip():raise RuntimeError('Tool archive validation failed')
        pending.replace(destination)
        digest=hashlib.file_digest(destination.open('rb'),'sha256').hexdigest()
        destination.with_suffix('.sha256').write_text(digest+'  '+destination.name+'\n')
        with zipfile.ZipFile(destination) as release_zip: meta['installed_size']=sum(i.file_size for i in release_zip.infolist())
        meta.update(size=destination.stat().st_size,sha256=digest)
        destination.with_suffix('.release.json').write_text(json.dumps(meta,indent=2)+'\n',encoding='utf-8')
        print(f'Built {destination} ({destination.stat().st_size//1024**2} MB)',flush=True)

if __name__=='__main__':
    import os
    import sys
    if '--standalone' in sys.argv:
        sys.argv.remove('--standalone')
        main()
    else:
        parser=argparse.ArgumentParser(description='Build a shared-Python Companion tool. Use --standalone for the legacy format.')
        parser.add_argument('--python',default=sys.executable)
        parser.add_argument('--version',default='0.2.0')
        parser.add_argument('--release-notes')
        parser.add_argument('--release-date')
        args=parser.parse_args()
        companion=Path(os.environ.get('IFS_COMPANION_PATH', Path(__file__).resolve().parents[2]/'ifs-companion'))
        command=[args.python,str(companion/'packaging/build_shared_tool.py'),'--tool','ifs-autotune','--version',args.version]
        if args.release_notes:command+=['--release-notes',args.release_notes]
        if args.release_date:command+=['--release-date',args.release_date]
        subprocess.run(command,check=True)
