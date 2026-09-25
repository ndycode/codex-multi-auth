import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY = "1";
const wrapper = (await import("../scripts/codex.js")) as {
	isRuntimeRotationProxyEnabled: (
		args: string[],
		env: NodeJS.ProcessEnv,
	) => Promise<boolean>;
};
delete process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY;
it("uses the native app binding instead of overlaying a custom provider", async () => {
	const home = await mkdtemp(join(tmpdir(), "native-wrapper-"));
	try {
		await writeFile(
			join(home, "config.toml"),
			'# codex-multi-auth native provider begin\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:43210"\n# codex-multi-auth native provider end\n',
		);
		expect(
			await wrapper.isRuntimeRotationProxyEnabled(["app"], {
				CODEX_HOME: home,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			}),
		).toBe(false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

it("gives native-specific remediation for an invocation account selector",async()=>{
 const home=await mkdtemp(join(tmpdir(),"native-selector-"));
 try {
  await writeFile(join(home,"config.toml"),'# codex-multi-auth native provider begin\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:43210"\n# codex-multi-auth native provider end\n');
  const binary=join(home,"codex-fixture.js");await writeFile(binary,'console.log("FORWARDED",process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX??"unset")');
  const run=promisify(execFile);
  await expect(run(process.execPath,["scripts/codex.js","--account","1","exec","test"],{env:{...process.env,CODEX_HOME:home,CODEX_MULTI_AUTH_REAL_CODEX_BIN:binary,CODEX_MULTI_AUTH_SKIP_UPDATE_CHECK:"1"}})).rejects.toMatchObject({stderr:expect.stringContaining("Use codex-multi-auth switch instead of --account")});
  const forwarded=await run(process.execPath,["scripts/codex.js","exec","test"],{env:{...process.env,CODEX_HOME:home,CODEX_MULTI_AUTH_REAL_CODEX_BIN:binary,CODEX_MULTI_AUTH_SKIP_UPDATE_CHECK:"1",CODEX_MULTI_AUTH_FORCE_ACCOUNT:"",CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX:"99"}});
  // A stale inherited index must be cleared before forwarding to native codex.
  expect(forwarded.stdout).toContain("FORWARDED unset");

 } finally{await rm(home,{recursive:true,force:true,maxRetries:5});}
});

it.each([null,"EPERM","EBUSY"])("forwards native launches even when auth-store persistence fails with %s",async failCode=>{
 const home=await mkdtemp(join(tmpdir(),"native-auth-store-"));
 const config=join(home,"config.toml");
 try {
  const original='# codex-multi-auth native provider begin\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:43210"\n# codex-multi-auth native provider end\n';
  await writeFile(config,original);
  await mkdir(join(home,"scripts"));await mkdir(join(home,"dist/lib/codex-cli"),{recursive:true});
  await writeFile(join(home,"package.json"),JSON.stringify({type:"module"}));
  for(const name of ["codex.js","codex-routing.js","codex-bin-resolver.js"])
   await copyFile(join("scripts",name),join(home,"scripts",name));
  // Isolate the wrapper contract from build output; the real writer is covered in codex-cli-writer.test.ts.
  await writeFile(join(home,"dist/lib/codex-cli/writer.js"),`
   import {writeFile,appendFile} from "node:fs/promises";
   export async function ensureCodexCliFileAuthStore(){
    await writeFile(${JSON.stringify(join(home,"writer-called"))},"called");
    if(${JSON.stringify(failCode)})throw Object.assign(Error("fixture denied"),{code:${JSON.stringify(failCode)}});
    await appendFile(${JSON.stringify(config)},'cli_auth_credentials_store = "file"\\n');
   }
  `);
  const binary=join(home,"codex-fixture.js");await writeFile(binary,'console.log(JSON.stringify(process.argv.slice(2)))');
  const {stdout}=await promisify(execFile)(process.execPath,[join(home,"scripts/codex.js"),"exec","-c",'model_reasoning_effort="xhigh"',"test"],{env:{...process.env,CODEX_HOME:home,CODEX_MULTI_AUTH_REAL_CODEX_BIN:binary,CODEX_MULTI_AUTH_SKIP_UPDATE_CHECK:"1",CODEX_MULTI_AUTH_FORCE_ACCOUNT:"",CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE:"1"}});
  const argv=JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "[]") as string[];
  expect(argv).toContain('cli_auth_credentials_store="file"');
  expect(argv).toContain('model_reasoning_effort="xhigh"');
  expect(await readFile(join(home,"writer-called"),"utf8")).toBe("called");
  const persisted=await readFile(config,"utf8");
  if(failCode)expect(persisted).toBe(original);
  else expect(persisted).toContain('cli_auth_credentials_store = "file"');
 } finally {await rm(home,{recursive:true,force:true,maxRetries:5});}
});
