import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const repo='chewner/ITERA-Rocket-Plans',releaseId=435429436;
const apiBase='https://api.github.com/repos/'+repo;
const token=process.env.GITHUB_TOKEN;
if(!token)throw new Error('Scoped workflow token required');
const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
const fixes=JSON.parse(await fs.readFile('fixes.json','utf8'));
const hash=async name=>{const h=createHash('sha256');for await(const chunk of createReadStream(name))h.update(chunk);return h.digest('hex');};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function api(route,options={}){
 const r=await fetch(apiBase+route,{...options,headers:{...headers,...options.headers}});
 if(!r.ok)throw new Error(`GitHub API ${r.status}: ${route}`);
 return r.status===204?null:r.json();
}
async function listAssets(){const all=[];for(let page=1;;page++){const rows=await api(`/releases/${releaseId}/assets?per_page=100&page=${page}`);all.push(...rows);if(rows.length<100)break;}return new Map(all.map(a=>[a.name,a]));}
let assets=await listAssets();
let pending=[...fixes].sort((a,b)=>a.old.bytes-b.old.bytes),done=0;
await fs.mkdir('work',{recursive:true});
for(let round=0;pending.length&&round<30;round++){
 const later=[];
 for(const fix of pending){
  const existing=assets.get(fix.updated.name);
  if(existing?.state==='uploaded'){
   if(existing.size!==fix.updated.bytes||existing.digest!=='sha256:'+fix.updated.sha256)throw new Error('Corrected asset mismatch: '+fix.updated.name);
   done++;continue;
  }
  const original=assets.get(fix.old.name);
  if(!original||original.state!=='uploaded'){later.push(fix);continue;}
  if(original.size!==fix.old.bytes||original.digest!=='sha256:'+fix.old.sha256)throw new Error('Original asset mismatch: '+fix.old.name);
  // A new workflow run may resume a prior failed upload. This job has a
  // concurrency lock; local uploads only create the distinct original names.
  if(existing){await api('/releases/assets/'+existing.id,{method:'DELETE'});await wait(1500);}
  let response=await fetch(apiBase+'/releases/assets/'+original.id,{headers:{...headers,Accept:'application/octet-stream'},redirect:'manual'});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');
   if(!location||new URL(location).protocol!=='https:')throw new Error('Unsafe asset redirect');
   // Never forward the workflow credential to a redirected asset host.
   response=await fetch(location);
  }
  if(!response.ok)throw new Error('Original download failed: '+response.status);
  await pipeline(Readable.fromWeb(response.body),createWriteStream('work/original.zip'));
  if(await hash('work/original.zip')!==fix.old.sha256)throw new Error('Original download hash mismatch');
  await fs.writeFile('work/links.json',JSON.stringify(fix.links));
  const result=JSON.parse(execFileSync('python',['repair-plan-manifest.py','work/original.zip','work/corrected.zip','work/links.json'],{encoding:'utf8',maxBuffer:1024*1024}));
  if(result.sha256!==fix.updated.sha256||result.bytes!==fix.updated.bytes)throw new Error('Corrected archive differs from verified local copy: '+fix.old.id+' '+JSON.stringify(result));
  const upload=await fetch(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fix.updated.name)}`,{method:'POST',headers:{...headers,'Content-Type':'application/zip','Content-Length':String(result.bytes)},body:createReadStream('work/corrected.zip'),duplex:'half'});
  if(!upload.ok)throw new Error('Corrected upload failed: '+upload.status+' '+fix.updated.name);
  const asset=await upload.json();
  if(asset.state!=='uploaded'||asset.size!==result.bytes||asset.digest!=='sha256:'+result.sha256)throw new Error('Corrected upload hash mismatch');
  assets.set(asset.name,asset);done++;
  // Only these three task-owned temporary files are removed. Original source
  // data and release assets are retained until a separate verified cleanup.
  for(const name of ['work/original.zip','work/corrected.zip','work/links.json'])await fs.unlink(name);
  console.log(JSON.stringify({corrected:done,total:fixes.length,kit:fix.old.id}));
  await wait(1500);
 }
 pending=later;
 if(pending.length){console.log(JSON.stringify({waitingForOriginals:pending.length}));await wait(30000);assets=await listAssets();}
}
if(pending.length)throw new Error('Original upload still incomplete; rerun to resume');
console.log(JSON.stringify({corrected:done,total:fixes.length,status:'complete'}));
