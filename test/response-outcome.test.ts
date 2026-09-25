import {expect,it} from "vitest";
import {ResponseOutcome} from "../lib/request/response-outcome.js";
it.each(["failed","cancelled"])("rejects non-streaming response status %s",status=>{
 const outcome=new ResponseOutcome(false);outcome.observe({object:"response",status,error:{code:"model_not_found",message:"must not retain"}});
 expect(outcome.finish().success).toBe(false);
 expect(JSON.stringify(outcome)).not.toContain("must not retain");
});
it("accepts a completed empty prewarm and cannot turn a failed event into success",()=>{
 const complete=new ResponseOutcome(true);complete.observe({type:"response.completed",response:{output:[]}});expect(complete.finish().success).toBe(true);
 const failed=new ResponseOutcome(true);failed.observe({type:"error",code:"model_not_found"});failed.observe({type:"response.completed"});expect(failed.finish().success).toBe(false);
 expect(failed.rejection?.error.code).toBe("model_not_found");
});
it.each([true,false])("treats an incomplete response as delivered and keeps its terminal type as an annotation (stream=%s)",stream=>{
 const outcome=new ResponseOutcome(stream);
 outcome.observe(stream?{type:"response.incomplete",response:{incomplete_details:{reason:"max_output_tokens"}}}:{object:"response",status:"incomplete"});
 expect(outcome.finish()).toEqual({success:true,missingTerminal:false,errorCode:"upstream_response_incomplete"});
});
it.each([["completed",true],["incomplete",true],["failed",false],["cancelled",false]] as const)("reads the nested status of response.done (%s)",(status,success)=>{
 const outcome=new ResponseOutcome(true);outcome.observe({type:"response.done",response:{status}});
 const result=outcome.finish();
 expect(result.success).toBe(success);expect(result.missingTerminal).toBe(false);
});
