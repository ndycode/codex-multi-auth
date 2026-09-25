import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { codexCliAccountIdFor } from '../auth/token-utils.js';
import type { CodexCliMirror } from '../storage/public-types.js';
import { getCodexMultiAuthDir } from '../runtime-paths.js';
import { isRecord } from '../utils.js';

export interface NativeUsageAuth {accessToken:string;accountId:string;expiresAt:number;idToken?:string;codexCliMirror?:CodexCliMirror}
/** Longer than any live session (15s timeout), so only crash leftovers are swept. */
const STALE_HOME_MS=10*60_000;
async function sweepStaleHomes(root:string):Promise<void>{
 const entries=await fs.readdir(root).catch(()=>[] as string[]);
 await Promise.all(entries.filter(name=>name.startsWith('reset-rpc-')).map(async name=>{
  const path=join(root,name);
  try{if(Date.now()-(await fs.stat(path)).mtimeMs>STALE_HOME_MS)await fs.rm(path,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{/* Another process owns or already removed it. */}
 }));
}
type Method='account/rateLimits/read'|'account/rateLimitResetCredit/consume';
function nativeCommand():string[]{
 const override=process.env.CODEX_MULTI_AUTH_USAGE_CODEX_BIN?.trim();
 if(override){if(!isAbsolute(override)||!existsSync(override))throw Error('Native usage executable must be an existing absolute path');return [override];}
 // Prefer the desktop backend whose protocol supplies the native usage UI.
 const bundled='/Applications/ChatGPT.app/Contents/Resources/codex';
 if(process.platform==='darwin'&&existsSync(bundled))return [bundled];
 try{return [process.execPath,createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')];}
 catch{throw Error('Native usage backend unavailable; set CODEX_MULTI_AUTH_USAGE_CODEX_BIN to the native Codex executable');}
}
/** One bounded native RPC session in an isolated home. No refresh token, API key,
 * global configuration, or desktop auth changes are available to this process. */
export async function nativeRateLimitsRpc(auth:NativeUsageAuth,method:Method,params:Record<string,unknown>,options:{command?:string[];tempRoot?:string;timeoutMs?:number}={}):Promise<unknown>{
 if(!auth.accessToken||!auth.accountId||auth.expiresAt<=Date.now()+30000)throw Error('Native usage requires a fresh account access token');
 const command=options.command??nativeCommand();const executable=command[0];if(!executable)throw Error('Native usage backend unavailable');
 // The home briefly holds an access token: keep it in the user-private multi-auth
 // directory (chmod is a no-op on Windows %TEMP%) and sweep leftovers of hard kills.
 const root=options.tempRoot??join(getCodexMultiAuthDir(),'tmp');
 await fs.mkdir(root,{recursive:true,mode:0o700});
 await sweepStaleHomes(root);
 const dir=await fs.mkdtemp(join(root,'reset-rpc-'));
 let stop:()=>Promise<void>=async()=>{};
 try{
  await fs.chmod(dir,0o700);
  await fs.writeFile(join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:auth.accessToken,id_token:auth.idToken??auth.accessToken,refresh_token:'',account_id:codexCliAccountIdFor(auth,auth.accessToken,auth.idToken)},last_refresh:new Date().toISOString()}),{mode:0o600});
  await fs.writeFile(join(dir,'config.toml'),'cli_auth_credentials_store = "file"\n',{mode:0o600});
  const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:dir};
  // A native backend must not inherit API authentication or our own proxy route.
  for(const key of ['NODE_OPTIONS','OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY'])delete env[key];
  const child=spawn(executable,[...command.slice(1),'app-server'],{env,cwd:dir,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited=new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
  stop=async()=>{if(child.exitCode===null&&child.signalCode===null&&child.pid){child.kill('SIGTERM');const timer=setTimeout(()=>{if(child.pid&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);try{await exited;}finally{clearTimeout(timer);}}};
  return await new Promise<unknown>((resolve,reject)=>{
   let buffer='';let phase=0;let done=false;
   const timer=setTimeout(()=>fail('timed out'),options.timeoutMs??15000);
   const fail=(reason:string)=>{if(done)return;done=true;clearTimeout(timer);reject(Error('Native usage '+reason));};
   const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
   child.on('error',()=>fail('backend failed to start'));child.on('exit',()=>fail('backend exited before replying'));child.stdin.on('error',()=>fail('backend pipe closed'));child.stderr.resume();
   child.stdout.setEncoding('utf8');child.stdout.on('data',(data:string)=>{
    if(done)return;buffer+=data;if(Buffer.byteLength(buffer)>1024*1024){fail('reply exceeded limit');return;}
    let newline:number;
    while((newline=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let reply:unknown;
     try{reply=JSON.parse(line)}catch{fail('reply was invalid');return;}
     if(!isRecord(reply)||reply.id!==phase+1)continue;
     if(reply.error){fail('operation rejected by backend');return;}
     if(phase===0){phase=1;send({method:'initialized'});send({id:2,method,params});}
     else{done=true;clearTimeout(timer);resolve(reply.result);return;}
    }
   });
   send({id:1,method:'initialize',params:{clientInfo:{name:'multi-auth-usage',version:'1.0'},capabilities:{experimentalApi:true}}});
  });
 }finally{await stop();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
