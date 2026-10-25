import { mkdir, writeFile } from 'node:fs/promises';

const SR = 48000, SECONDS = 8, N = SR * SECONDS;
function wav(samples) {
  const b = Buffer.alloc(44 + samples.length * 2); b.write('RIFF',0); b.writeUInt32LE(36+samples.length*2,4); b.write('WAVE',8); b.write('fmt ',12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(SR,24); b.writeUInt32LE(SR*2,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(samples.length*2,40);
  samples.forEach((x,i)=>b.writeInt16LE(Math.max(-1,Math.min(1,x))*32767,44+i*2)); return b;
}
const t=i=>i/SR, beat=i=>Math.floor(t(i)*2), env=(x,d=.08)=>Math.min(1,x/d,(1-x)/d);
function render(kind) { const s=new Float32Array(N); for(let i=0;i<N;i++){const q=t(i), ph=q%2, k=beat(i), e=env(ph%1); let x=0;
  if(kind==='exploration') x=.22*Math.sin(2*Math.PI*220*q)+.16*Math.sin(2*Math.PI*277.18*q)+.10*Math.sin(2*Math.PI*329.63*q)+.04*Math.sin(2*Math.PI*2*q);
  if(kind==='combat') x=.22*Math.sin(2*Math.PI*110*q)+.12*Math.sin(2*Math.PI*146.83*q)+((k%4===0)?-.42*Math.exp(-((ph%2)*9)):0)+((k%2===1)? .18*Math.sin(2*Math.PI*440*q)*Math.exp(-((ph%1)*14)):0);
  if(kind==='intensity') x=((k%2===0)?.25:-.18)*Math.sin(2*Math.PI*880*q)+.12*Math.sin(2*Math.PI*1320*q);
  if(kind==='voice') { const f=220+(k%4)*55; x=.20*Math.sin(2*Math.PI*f*q)+.12*Math.sin(2*Math.PI*2*f*q)+.07*Math.sin(2*Math.PI*3*f*q)+.04*Math.sin(2*Math.PI*4*f*q); x*=.65+.35*Math.sin(2*Math.PI*.25*q); }
  if(kind==='stinger'){const z=q; x=(.6*Math.sin(2*Math.PI*(330+500*z)*z)+.3*Math.sin(2*Math.PI*(660+800*z)*z))*Math.exp(-z*3.5);}
  s[i]=x*(kind==='stinger'?1:0.7)*(kind==='combat'||kind==='intensity'?Math.min(1,e+.15):1); } return wav(s); }
await mkdir(new URL('./audio/', import.meta.url),{recursive:true});
for(const name of ['exploration','combat','intensity','voice','stinger']) await writeFile(new URL(`./audio/${name}.wav`,import.meta.url),render(name));
console.log('Generated original adaptive music stems in demo/audio/');
