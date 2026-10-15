#!/usr/bin/env node
// Copy complete, verified derived films into the existing hosted player.
import {createHash} from 'node:crypto';
import {readFile, readdir, mkdir, copyFile, appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'web-player/public/media/2026');
const checkout=path.join(root,'.sites/lapform-deploy');
const hosting=JSON.parse(await readFile(path.join(checkout,'.openai/hosting.json')));
if(hosting.project_id!=='appgprj_6a5793fec7848191a0e76239e6100a8b')throw new Error('Expected the existing Lapform Site.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ignore=path.join(checkout,'apps/babot/.gitignore');
if(!(await readFile(ignore,'utf8')).includes('!public/media/**'))await appendFile(ignore,'\n# Published derived films are part of this Site source snapshot.\n!public/media/\n!public/media/**\n');
let copied=0;
for(const entry of await readdir(source,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^[a-z0-9-]+$/.test(entry.name))continue;
  const dir=path.join(source,entry.name);
  let manifest;
  try{manifest=JSON.parse(await readFile(path.join(dir,'ribbon.json')));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const fixtureBytes=await readFile(path.join(root,'web-player/public/data/2026',entry.name+'.json'));
  const fixture=JSON.parse(fixtureBytes);
  if(manifest.datasetId!==fixture.meta.datasetId||manifest.verification?.fullDecode!==true||manifest.verification.sourceSha256!==sha(fixtureBytes)||manifest.src!==`/media/2026/${entry.name}/ribbon.mp4`||manifest.verification.sha256!==sha(await readFile(path.join(dir,'ribbon.mp4'))))throw new Error('Unverified film: '+entry.name);
  const target=path.join(checkout,'apps/babot/public/media/2026',entry.name);
  await mkdir(target,{recursive:true});
  for(const file of ['ribbon.mp4','poster.jpg','ribbon.json','ribbon-progress.json'])await copyFile(path.join(dir,file),path.join(target,file));
  copied++;
}
console.log(`Copied ${copied} complete season ribbon films. Pending render progress was not published.`);
