import { beforeEach, expect, it, vi } from 'vitest';
const f=vi.hoisted(()=>({list:vi.fn(),redeem:vi.fn(),policy:vi.fn(),refresh:vi.fn(),capabilities:vi.fn(),extraAccounts:[] as Array<Record<string,unknown>>}));
vi.mock('../lib/runtime/account-reset-credits.js',async original=>({...await original<typeof import('../lib/runtime/account-reset-credits.js')>(),createResetCreditService:()=>({status:f.list,redeem:f.redeem,setPolicy:f.policy,refresh:f.refresh})}));
vi.mock('../lib/runtime/model-discovery-status.js',async original=>({...await original<typeof import('../lib/runtime/model-discovery-status.js')>(),refreshAndPrintModelInventory:f.capabilities}));
vi.mock('../lib/storage.js',async original=>({...await original<typeof import('../lib/storage.js')>(),loadAccounts:async()=>({version:3,activeIndex:0,accounts:[{accountId:'workspace',email:'reader@example.test',refreshToken:'secret',addedAt:1,lastUsed:1},...f.extraAccounts]})}));
import { runResetsCommand } from '../lib/codex-manager/commands/resets.js';
beforeEach(()=>{vi.clearAllMocks();f.extraAccounts=[];vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});f.list.mockResolvedValue({version:1,policy:'manual',snapshots:{}});f.redeem.mockResolvedValue('reset');f.capabilities.mockResolvedValue(true);});
it('lists without provider reads or redemption by default',async()=>{expect(await runResetsCommand([])).toBe(0);expect(f.refresh).not.toHaveBeenCalled();expect(f.redeem).not.toHaveBeenCalled();});
it('requires an explicit valid account to redeem',async()=>{for(const args of [['redeem'],['redeem','0'],['redeem','2'],['redeem','1','extra']])expect(await runResetsCommand(args)).toBe(1);expect(f.redeem).not.toHaveBeenCalled();expect(await runResetsCommand(['redeem','1'])).toBe(0);expect(f.redeem).toHaveBeenCalledTimes(1);});
it('changes policy only by explicit command',async()=>{expect(await runResetsCommand(['auto','last-resort'])).toBe(0);expect(f.policy).toHaveBeenCalledWith('last-resort');expect(f.redeem).not.toHaveBeenCalled();});
it('does not retry an ambiguous redemption or print secret backend errors',async()=>{f.redeem.mockRejectedValue(Error('secret'));expect(await runResetsCommand(['redeem','1'])).toBe(1);expect(f.redeem).toHaveBeenCalledTimes(1);expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret');});
it('routes the standalone resets command through the CLI dispatcher',async()=>{
 const {runCodexMultiAuthCli}=await import('../lib/codex-manager.js');expect(await runCodexMultiAuthCli(['resets','--help'])).toBe(0);expect(f.redeem).not.toHaveBeenCalled();
});

it('check resets refreshes counts and prints emails without redeeming credits', async () => {
 f.refresh.mockResolvedValue({});
 const {runCodexMultiAuthCli}=await import('../lib/codex-manager.js');
 expect(await runCodexMultiAuthCli(['check','resets'])).toBe(0);
 expect(f.refresh).toHaveBeenCalledTimes(1);
 expect(f.redeem).not.toHaveBeenCalled();
 expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Account 1 (reader@example.test): unknown reset credits'));
});

it('check capabilities refreshes only model discovery through the CLI dispatcher', async () => {
 const {runCodexMultiAuthCli}=await import('../lib/codex-manager.js');
 expect(await runCodexMultiAuthCli(['check','capabilities'])).toBe(0);
 expect(f.capabilities).toHaveBeenCalledTimes(1);
 // Only this explicit command may bypass the 15-minute paid-probe cache.
 expect(f.capabilities).toHaveBeenCalledWith(expect.any(Function), { forceProbes: true });
 expect(f.refresh).not.toHaveBeenCalled(); expect(f.redeem).not.toHaveBeenCalled();
});

it('reports reset availability read failures without claiming a pending redemption', async () => {
 f.refresh.mockRejectedValue(Error('secret backend detail'));
 expect(await runResetsCommand(['list','--refresh'])).toBe(1);
 expect(console.error).toHaveBeenCalledWith('Reset-credit availability could not be refreshed. No credits were redeemed.');
 expect(f.redeem).not.toHaveBeenCalled();
});

it.each([false,true])('restores the caller storage state after standalone reset list (failure=%s)',async fails=>{
 const {runWithStoragePathState,getStoragePathState}=await import('../lib/storage/path-state.js');
 const previous={currentStoragePath:'/fixture/shared/project/accounts.json',currentProjectRoot:'/fixture/project',currentLegacyProjectStoragePath:'/fixture/project/.legacy/accounts.json',currentLegacyWorktreeStoragePath:'/fixture/old-worktree/accounts.json'};
 if(fails)f.list.mockRejectedValueOnce(Error('provider unavailable'));
 await runWithStoragePathState(previous,async()=>{
  expect(await runResetsCommand(['list'])).toBe(fails?1:0);
  expect(getStoragePathState()).toEqual(previous);
 });
});

it('does not claim a pending redemption when redeem fails before consuming', async () => {
 f.redeem.mockRejectedValue(Error('A reset was just redeemed; refresh usage before trying again.'));
 expect(await runResetsCommand(['redeem','1'])).toBe(1);
 const output=JSON.stringify(vi.mocked(console.error).mock.calls);
 expect(output).not.toMatch(/pending/);
 expect(output).toContain('No reset credit was redeemed');
});

it('reports a pending result only when a consume is actually unconfirmed', async () => {
 f.redeem.mockRejectedValue(Error('secret backend detail'));
 f.list.mockResolvedValue({version:1,policy:'manual',snapshots:{},pending:{key:'k'}});
 expect(await runResetsCommand(['redeem','1'])).toBe(1);
 const output=JSON.stringify(vi.mocked(console.error).mock.calls);
 expect(output).toMatch(/pending/);expect(output).not.toContain('secret');
});

it('names the account that owns a pending redemption when it is not the one retried', async () => {
 const {resetTargetForStoredAccount}=await import('../lib/runtime/account-reset-credits.js');
 const other={accountId:'other-workspace',email:'other@example.test',refreshToken:'secret-2',addedAt:1,lastUsed:1};
 f.extraAccounts=[other];
 const key=resetTargetForStoredAccount(other as never)!.key;
 f.redeem.mockRejectedValue(Error('A redemption result is pending'));
 f.list.mockResolvedValue({version:1,policy:'manual',snapshots:{},pending:{key}});
 expect(await runResetsCommand(['redeem','1'])).toBe(1);
 const output=JSON.stringify(vi.mocked(console.error).mock.calls);
 expect(output).toContain('account 2');
 expect(output).not.toContain('retry the same account');
});
it('identifies a disabled pending account without calling it removed',async()=>{
 const {resetTargetForStoredAccount}=await import('../lib/runtime/account-reset-credits.js');
 const other={accountId:'other-workspace',refreshToken:'fixture',addedAt:1,lastUsed:1};
 const key=resetTargetForStoredAccount(other)!.key;f.extraAccounts=[{...other,enabled:false}];
 f.redeem.mockRejectedValue(Error('pending'));f.list.mockResolvedValue({version:1,policy:'manual',snapshots:{},pending:{key}});
 expect(await runResetsCommand(['redeem','1'])).toBe(1);
 const output=JSON.stringify(vi.mocked(console.error).mock.calls);
 expect(output).toContain('account 2');expect(output).toContain('disabled');expect(output).not.toContain('was removed');
});
