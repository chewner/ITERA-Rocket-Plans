"""Correct added ZIP provenance metadata while preserving all original file bytes.

The generated file-manifest.json is the final member in these packages. Copying
the prefix preserves the original compressed members and their headers exactly.
The replacement manifest is stored uncompressed for deterministic cross-platform
hashes. Its original timestamp and metadata are retained.
"""
import argparse, copy, hashlib, json, zipfile
from pathlib import Path

def hash_file(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def repair(source, target, links):
    source,target=Path(source),Path(target)
    if source.resolve()==target.resolve():raise ValueError('Use a separate output path')
    with zipfile.ZipFile(source) as original:
        infos=original.infolist()
        final=infos[-1]
        if not final.filename.endswith('/file-manifest.json'):raise ValueError('Manifest must be the final member')
        if any(info.header_offset>final.header_offset for info in infos[:-1]):raise ValueError('Unexpected member order')
        manifest=json.loads(original.read(final.filename))
        known={f['archivePath'] for f in manifest['files']}
        if set(links)-known:raise ValueError('Unknown source file in correction')
        for file in manifest['files']:
            if file['archivePath'] in links:file['sourceUrl']=links[file['archivePath']]
        content=json.dumps(manifest,indent=2).encode('utf-8')
        with source.open('rb') as incoming,target.open('w+b') as output:
            remaining=final.header_offset
            while remaining:
                chunk=incoming.read(min(1024*1024,remaining))
                if not chunk:raise ValueError('Unexpected end of original ZIP')
                output.write(chunk);remaining-=len(chunk)
            with zipfile.ZipFile(output,'a',compression=zipfile.ZIP_STORED,allowZip64=True) as patched:
                patched.filelist=copy.deepcopy(infos[:-1])
                patched.NameToInfo={info.filename:info for info in patched.filelist}
                patched.start_dir=final.header_offset
                new_info=copy.deepcopy(final)
                new_info.compress_type=zipfile.ZIP_STORED
                patched.writestr(new_info,content)
    with zipfile.ZipFile(target) as archive:
        if archive.testzip():raise ValueError('Repaired archive failed CRC validation')
    return {'sha256':hash_file(target),'bytes':target.stat().st_size}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('source',type=Path)
    parser.add_argument('target',type=Path)
    parser.add_argument('links',type=Path)
    args=parser.parse_args()
    print(json.dumps(repair(args.source,args.target,json.loads(args.links.read_text(encoding='utf-8')))))
