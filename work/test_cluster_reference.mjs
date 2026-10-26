import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {validateAnnotations} from './seal_cluster_reference.mjs';
const p='ui_data/insights/comparisons/cluster-reference-codex-20261017/';
const read=f=>JSON.parse(fs.readFileSync(p+f,'utf8'));
const packet=read('blind-packet.json'),manifest=read('manifest.json'),annotations=read('reference-labels.json'),taxonomy=read('protocol.json').taxonomy;
test('all 160 sealed annotations have exact evidence, valid labels, complete IDs and company disjoint split',()=>assert.equal(validateAnnotations(packet,manifest,annotations,taxonomy),true));
test('all sealed hashes remain unchanged',()=>{
 for(const [file,sha] of Object.entries(read('reference-seal.json').hashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p+file)).digest('hex'),sha);
});
test('incomplete annotations rejected',()=>assert.throws(()=>validateAnnotations(packet,manifest,annotations.slice(1),taxonomy)));
test('duplicate IDs rejected',()=>assert.throws(()=>validateAnnotations(packet,manifest,[annotations[0],...annotations.slice(0,-1)],taxonomy)));
test('fabricated evidence rejected',()=>assert.throws(()=>validateAnnotations(packet,manifest,[{...annotations[0],quote:'THIS QUOTE IS NOT IN ANY JD'},...annotations.slice(1)],taxonomy)));
test('invalid category rejected',()=>assert.throws(()=>validateAnnotations(packet,manifest,[{...annotations[0],label:'invented'},...annotations.slice(1)],taxonomy)));
