import {it,expect} from 'vitest';
import {ResponseOutputHistory,hasOrphanToolResult} from '../lib/runtime/response-output-history.js';
it('bounds aggregate streamed history without disrupting forwarded events',()=>{
 const history=new ResponseOutputHistory(100);
 history.observe({type:'response.output_item.done',output_index:0,item:{id:'a',type:'message',content:'x'.repeat(70)}});
 expect(history.finish([])).toBeUndefined();
});
it('rejects malformed output indices without constructing sparse histories',()=>{
 const history=new ResponseOutputHistory(1000);
 history.observe({type:'response.output_item.done',output_index:-1,item:{id:'a'}});
 expect(history.finish([])).toBeUndefined();
});
it('accepts a terminal item that completes an added placeholder without duplicating it',()=>{
 const history=new ResponseOutputHistory(1000);
 history.observe({type:'response.output_item.added',output_index:0,item:{id:'a',type:'function_call',arguments:''}});
 const final={id:'a',type:'function_call',call_id:'call',arguments:'{}'};
 expect(history.finish([final])).toEqual([final]);
});
it.each(['custom_tool_call','function_call'])('requires a preceding matching %s for each result',type=>{
 const call={type,call_id:'fixture'}, result={type:type+'_output',call_id:'fixture'};
 expect(hasOrphanToolResult([call,result])).toBe(false);
 expect(hasOrphanToolResult([result,call])).toBe(true);
 expect(hasOrphanToolResult([{...call,call_id:'other'},result])).toBe(true);
 expect(hasOrphanToolResult([{...call,type:'other'},result])).toBe(true);
});
