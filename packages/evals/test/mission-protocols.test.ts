import {it,expect,vi}from 'vitest';
import {CheckpointedModel}from '../../../apps/runtime/src/agents.js';
import {mkdtemp,rm}from 'node:fs/promises';
import {join}from 'node:path';
import {tmpdir}from 'node:os';
import {createBuiltinScenarioDriver}from '../src/mission-scenario-protocols.js';
import {runMissionScenarios,FileScenarioCheckpoints}from '../src/mission-scenarios.js';
it('executes built-in actual model-service and payment protocol slices without a live provider request',async()=>{const directory=await mkdtemp(join(tmpdir(),'lo-builtins-')),driver=await createBuiltinScenarioDriver({mode:'test_protocol',directory});const original=CheckpointedModel.prototype.getResponse,spy=vi.spyOn(CheckpointedModel.prototype,'getResponse').mockImplementation(function(this:CheckpointedModel,request){process.stderr.write(JSON.stringify({syntheticProtocolBudgetProbe:true,inputUpperBound:Buffer.byteLength(JSON.stringify({instructions:request.systemInstructions,input:request.input,tools:request.tools,output:request.outputType}),'utf8'),tokenLimit:Reflect.get(this,'tokenLimit')})+'\n');return original.call(this,request);});try{const report=await runMissionScenarios({driver,checkpoints:new FileScenarioCheckpoints(join(directory,'steps')),directory,ids:['S4','A17']});expect(report.cases.map(c=>[c.id,c.status,c.reason,c.protocol.map(p=>p.kind)])).toEqual([['S4','passed',null,[]],['A17','passed',null,[]]]);expect(report.releaseQualifying).toBe(false);}finally{spy.mockRestore();await driver.close();await rm(directory,{recursive:true,force:true});}},30000);
