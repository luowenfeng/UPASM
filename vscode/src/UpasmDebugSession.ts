import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent,
	Scope, StackFrame, Breakpoint, Source, Thread
} from 'vscode-debugadapter';
import * as fs from 'fs-extra';
import { Subject } from 'await-notify';
import { DebugProtocol } from 'vscode-debugprotocol';
import { UpasmClient } from './UpasmClient';
import { basename } from 'path';
import * as path from 'path';

import { bytes_2_short, bytes_2_word, padZero, parseValueBytes, short_2_bytes, UpasmReference, UpasmReferenceManager, word_2_bytes } from './UpasmReference';

const REG32_REF_ID = 1;
const REG64_REF_ID = 2;
const REG128_REF_ID = 3;
export const REG256_REF_ID = 4;

interface IRWCommand {
	type: 'read'|'write'|'dumpbin'|'invalid';
	step: 4|2|1;
	addr: number;
	lengthOrValue: number;
	toFile: string;
	append: boolean;
	hex_or_dec: 'hex'|'dec'|'float';
}

function hex2float_str(num:number) {
    if (num == 0) return '0';

	var float = 0;
    var sign = (num & 0x80000000) ? -1 : 1;
    var exp = ((num >> 23) & 0xff) - 127;
    var mantissa = ((num & 0x7fffff) + 0x800000).toString(2);
	for (let i=0; i<mantissa.length; i+=1){
		float += parseInt(mantissa[i])? Math.pow(2,exp):0;
		exp--;
	}
    return (sign * float).toString();
}

function float2hex(d:number) {

    var sign = "0";
    if(d<0.0){
        sign = "1";
        d = -d;
    }

    var mantissa = d.toString(2);
    var exponent = 0;
    if(mantissa.substring(0,1) === "0"){
        exponent = mantissa.indexOf('.') - mantissa.indexOf('1') + 127;
    }
    else{
        exponent = mantissa.indexOf('.') - 1 + 127;
    }

    mantissa = mantissa.replace(".", "");
    mantissa = mantissa.substring(mantissa.indexOf('1')+1);
    if(mantissa.length>23){
        mantissa = mantissa.substring(0,23);
    }
    else{
        while(mantissa.length<23){
            mantissa = mantissa +"0";
        }
    }

    var exp = exponent.toString(2);
    while(exp.length<8){
        exp = "0" + exp;
    }
    var numberFull = sign + exp + mantissa;
    return parseInt(numberFull, 2);//.toString(16);
}

function decodeRWCommand(expression:string, filename:string, currLine:number, refMgr:UpasmReferenceManager)
{
	let cmd:IRWCommand = {type:'invalid', step:4, addr:-1, lengthOrValue:-1, toFile:"", append:true, hex_or_dec:'hex'};
	let parts = expression.split(' ').filter(item => item != '');
	if (parts.length == 5 && parts[3] == '>>') {
		cmd.toFile = parts[4];
		cmd.append = false;
		parts = [parts[0], parts[1], parts[2]];
	}
	else if (parts.length == 5 && parts[3] == '>>>') {
		cmd.toFile = parts[4];
		cmd.append = true;
		parts = [parts[0], parts[1], parts[2]];
	}

	
	if (parts.length == 3) {
		cmd.addr = Number.parseInt(parts[1]);
		if (isNaN(cmd.addr)) {
			if (parts[1].includes('+')) {
				let src = parts[1].split('+');
				let base = Number.parseInt(src[0]);
				if (isNaN(base)) {
					let num = refMgr.getNamedValue(filename, currLine, src[0]);
					if (num != undefined && !isNaN(num)) {
						base = num;
					}
				}
				let off = Number.parseInt(src[1]);
				if (!isNaN(base)) {
					cmd.addr = base + off;
				}
			}
			else {
				let num = refMgr.getNamedValue(filename, currLine, parts[1]);
				if (num != undefined && !isNaN(num)) {
					cmd.addr = num;
				}
			}
		}

		cmd.lengthOrValue = Number.parseInt(parts[2]);
		if (!isNaN(cmd.addr) && cmd.addr >= 0 && cmd.addr <= 0xffffffff && !isNaN(cmd.lengthOrValue)) {
			if (parts[0].length >= 2) {
				let maxv = 0xff;
				switch(parts[0][1]) {
				case 'f': cmd.step = 4; cmd.hex_or_dec = 'float'; break;
				case 'w': cmd.step = 4; maxv = 0xffffffff; break;
				case 's': cmd.step = 2; maxv = 0xffff; break;
				case 'b': cmd.step = 1; break;
				default: return cmd;
				}

				if (parts[0][0] == 'r') {
					switch (parts[0].length) {
					case 2:
						if (cmd.lengthOrValue > 0 && cmd.addr + cmd.lengthOrValue <= 0xffffffff && cmd.lengthOrValue % cmd.step == 0) {
							cmd.type = 'read';
						}
						break;
					case 3:
						if (cmd.lengthOrValue > 0 && cmd.addr + cmd.lengthOrValue <= 0xffffffff && cmd.lengthOrValue % cmd.step == 0) {
							cmd.type = 'read';
							if (parts[0][2] == 'd') {
								cmd.hex_or_dec = 'dec';
							}
						}
						break;

					default: break;
					}					
				}
				else if (parts[0][0] == 'w') {
					if (parts[0][1] == 'f') {
						cmd.type = 'write';
						let v = Number.parseFloat(parts[2]);						
						cmd.lengthOrValue = float2hex(v);
					}
					else if (parts[0].length == 2 && cmd.lengthOrValue >= 0 && cmd.lengthOrValue <= maxv && cmd.addr + cmd.step <= 0xffffffff) {
						cmd.type = 'write';
					}
				}
			}
		}
	}
	else if (parts.length == 4 && parts[0] == 'dumpbin') {
		cmd.addr = Number.parseInt(parts[1]);
		cmd.lengthOrValue = Number.parseInt(parts[2]);
		cmd.toFile = parts[3];
		cmd.type = 'dumpbin';
	}
	return cmd;
}

function suppression(v:number, maxv:number) : number 
{
	if (v > maxv) v = -(maxv*2+2-v);
	return v;
}

const UPASM_THREAD = 1;

export class UpasmDebugSession extends LoggingDebugSession {
	private useSimulator:boolean;
	private client:UpasmClient;
	private refMgr:UpasmReferenceManager;
	private currFilename:string;
	private currLine:number;
	private _configurationDone = new Subject();
	private lastExpression = '';
	private _rootPath = '';
	public set rootPath(p:string) {this._rootPath = p;}

	public constructor(useSimulator:boolean, refMgr:UpasmReferenceManager, currFilename:string, currLine:number, event:EventEmitter, client:UpasmClient)
	{
		super('upasm-debug.txt');
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
		this.currFilename = currFilename;
		this.currLine = currLine;
		this.useSimulator = useSimulator;
		this.client = client;
		this.refMgr = refMgr;
		event.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', UPASM_THREAD),);
		});
		event.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', UPASM_THREAD));
		});
		event.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', UPASM_THREAD));
		});
		// event.on('stopOnDataBreakpoint', () => {
		// 	this.sendEvent(new StoppedEvent('data breakpoint', UPASM_THREAD));
		// });
		event.on('error', (...args) => {
			let text = '';
			for (const arg of args) {
				text += arg + '\n';
			}
			vscode.window.showErrorMessage(text);
			this.sendEvent(new TerminatedEvent());
		});
		event.on('warning', (...args) => {
			let text = '';
			for (const arg of args) {
				text += arg + '\n';
			}
			const e: DebugProtocol.OutputEvent = new OutputEvent('Warning: '+ text, 'console');
			this.sendEvent(e);
		});
		event.on('output', (...args) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${args}\n`);
			this.sendEvent(e);
		});
		event.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	public setCurrentPosition(currFilename:string, currLine:number)
	{
		this.currFilename = currFilename;
		this.currLine = currLine;
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code send cancel request
		response.body.supportsCancelRequest = true;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;		

		response.body.supportsSetExpression = true;
		response.body.supportsEvaluateForHovers = true;

		if (this.useSimulator) {
			response.body.supportsStepBack = true;
		}

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments) {
		await this._configurationDone.wait(1000);

		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
		try {
			const res = this.client.restartDebug();
			if (res.ok) {
				this.currFilename = res.filename;
				this.currLine = res.lineNum;
				this.refMgr.updateWatcher();						
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent('entry', UPASM_THREAD));
			}
			else {
				throw res.reason;
			}	
		} catch (error) {
			vscode.window.showErrorMessage(error as string);
			this.sendEvent(new TerminatedEvent());
		}		
	}

	shutdown(): void {
		const res = this.client.stopDebug();
		if (!res.ok) {
			vscode.window.showErrorMessage(res.reason);
			this.sendEvent(new TerminatedEvent());
		}
		super.shutdown();
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
		const path = args.source.path as string;
		if (args.lines) {
			let lines = args.lines.map((v, idx)=> { return this.convertClientLineToDebugger(v); });
			try {
				let breakPoints = [];
				let res = this.client.setBreakpoints(path, lines);
				if (res.ok) {
					for (const line of res.lines) {
						breakPoints.push(new Breakpoint(true, this.convertDebuggerLineToClient(line)));
					}
					response.body = {
						breakpoints: breakPoints
					};
				}
				else {
					throw res.reason;
				}				
			} catch (error) {
				vscode.window.showErrorMessage(error as string);
			}
		}
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(UPASM_THREAD, 'thread 1')
			]
		};
		this.sendResponse(response);
	}


	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'upasm-adapter-data');
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		response.body = {
			stackFrames: [new StackFrame(0, '', this.createSource(this.currFilename), this.currLine+1)],
			totalFrames: 1
		};
		this.sendResponse(response);
	}
	
	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, request?: DebugProtocol.Request): void {
		if (this.useSimulator) {
			try {
				const res = this.client.stepbackDebug();
				if (res.ok) {
					this.currFilename = res.filename;
					this.currLine = res.lineNum;
					this.refMgr.updateWatcher();
					this.sendResponse(response);
					this.sendEvent(new StoppedEvent('step', UPASM_THREAD));
				}
				else {
					throw res.reason;
				}
			} catch (error) {
				vscode.window.showErrorMessage(error as string);
				this.sendEvent(new TerminatedEvent());
			}
		}
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments, request?: DebugProtocol.Request): void {
		// not implemented
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		try {
			const res = this.client.stepDebug();
			if (res.ok) {
				this.currFilename = res.filename;
				this.currLine = res.lineNum;
				this.refMgr.updateWatcher();
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent('step', UPASM_THREAD));
			}
			else {
				throw res.reason;
			}
		} catch (error) {
			vscode.window.showErrorMessage(error as string);
			this.sendEvent(new TerminatedEvent());
		}
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void
	{
		try {
			const res = this.client.stepDebug();
			if (res.ok) {
				this.currFilename = res.filename;
				this.currLine = res.lineNum;
				this.refMgr.updateWatcher();
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent('step', UPASM_THREAD));
			}
			else {
				throw res.reason;
			}
		} catch (error) {
			vscode.window.showErrorMessage(error as string);
			this.sendEvent(new TerminatedEvent());
		}
	}

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void
	{
		try {
			const res = this.client.stepDebug();
			if (res.ok) {
				this.currFilename = res.filename;
				this.currLine = res.lineNum;
				this.refMgr.updateWatcher();
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent('step', UPASM_THREAD));
			}
			else {
				throw res.reason;
			}
		} catch (error) {			
			vscode.window.showErrorMessage(error as string);
			this.sendEvent(new TerminatedEvent());
		}
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		const res = this.client.continueDebug();
		if (res.ok) {
			this.sendResponse(response);
		}
		else {
			vscode.window.showErrorMessage(res.reason);
			this.sendEvent(new TerminatedEvent());
		}
	}

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request) {
		try {
			const res = this.client.pauseDebug();
			if (res.ok) {
				this.currFilename = res.filename;
				this.currLine = res.lineNum;
				this.refMgr.updateWatcher();
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent('step', UPASM_THREAD));
			}
			else {
				throw res.reason;
			}
		} catch (error) {
			vscode.window.showErrorMessage(error as string);
			this.sendEvent(new TerminatedEvent());
		}
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		let scopes = [];
		if (this.refMgr.reg32Count > 0) {
			scopes.push(new Scope('寄存器(32位)', REG32_REF_ID, true));
		}
		if (this.refMgr.reg64Count > 0) {
			scopes.push(new Scope('寄存器(64位)', REG64_REF_ID, true));
		}
		if (this.refMgr.reg128Count > 0) {
			scopes.push(new Scope('寄存器(128位)', REG128_REF_ID, true));
		}
		if (this.refMgr.reg256Count > 0) {
			scopes.push(new Scope('寄存器(256位)', REG256_REF_ID, true));
		}
		
		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		let vars:DebugProtocol.Variable[] = [];
		switch(args.variablesReference) {
		case REG32_REF_ID:
			for (let i=0; i<this.refMgr.reg32Count; i++) {
				let ref = this.refMgr.getRegister(i)!;
				vars.push({
					name: 'r' + i,
					value: ref.values[0].value,
					type: 'number',
					variablesReference: 0
				});
			}
			break;

		case REG64_REF_ID:
			for (let i=0; i<this.refMgr.reg64Count; i++) {
				let idx = i + this.refMgr.reg32Count;
				let ref = this.refMgr.getRegister(idx)!;
				vars.push({
					name: 'r' + idx,
					value: '64 bit register',
					variablesReference: ref.refID
				});
			}
			break;

		case REG128_REF_ID:
			for (let i=0; i<this.refMgr.reg128Count; i++) {
				let idx = i + this.refMgr.reg32Count + this.refMgr.reg64Count;
				let ref = this.refMgr.getRegister(idx)!;
				vars.push({
					name: 'r' + idx,
					value: '128 bit register',
					variablesReference: ref.refID
				});
			}
			break;

		case REG256_REF_ID:
			for (let i=0; i<this.refMgr.reg256Count; i++) {
				let idx = i + this.refMgr.reg32Count + this.refMgr.reg64Count + this.refMgr.reg128Count;
				let ref = this.refMgr.getRegister(idx)!;
				vars.push({
					name: 'r' + idx,
					value: '256 bit register',
					variablesReference: ref.refID
				});
			}
			break;

		default:
			let ref = this.refMgr.getRefByID(args.variablesReference);
			if (ref == undefined) {
				vars.push({
					name: 'Invalid reference id(' + args.variablesReference + ')',
					value: '???',
					variablesReference: 0
				});
			}
			else {
				for (const v of ref.values) {
					vars.push({
						name: v.name,
						value: v.value,
						variablesReference: 0
					});
				}
			}
			break;	
		}

		response.body = {
			variables: vars
		};
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments) {
		let ref = this.refMgr.getRefByID(args.variablesReference);
		let idx = Number.parseInt(args.name.substring(1));

		if (ref) {
			try {
				//idx *= ref.format.step;
				let bytes = parseValueBytes(args.value, ref.format);
				for (let i=0; i<ref.format.step; i++) {
					ref.data.bytes[i + idx*ref.format.step] = bytes[i];
				}
				let res:{ok:boolean, reason:string} = {ok:false, reason:''};
				if (ref.isRegister) {
					res = this.client.writeRegister(ref.data.idxOrAddr, ref.data.bytes);
				}
				else {
					res = this.client.writeMemory(ref.data.idxOrAddr, ref.data.bytes);
				}

				if (res.ok) {
					response.body = {
						value:ref.values[idx].value
					};
				}
				else {
					throw res.reason;
				}				
			} catch (error) {
				vscode.window.showErrorMessage(error as string);
				this.sendEvent(new TerminatedEvent());
			}
		}
		this.sendResponse(response);
	}

	private setEvaluateResponseBody(response: DebugProtocol.EvaluateResponse, expression:string)
	{
		let ref:UpasmReference|undefined = undefined;
		try {
			ref = this.refMgr.watchExpression(this.currFilename, this.currLine, expression);	
		} catch (error) {
			return {
				result: 'Error:' + error,
				type: 'error',
				variablesReference: 0
			};
		}
		
		let values = ref.values;
		if (values.length > 1) {
			let name = values.length.toString() + ' ';
			switch(ref.format.step) {
			case 1: name += '8-bit '; break;
			case 2: name += '16-bit '; break;
			case 4: name += '32-bit '; break;
			}
			name += ref.format.type;
			name += 'data';
			return {
				result: name,
				type: 'memory',
				variablesReference: ref.refID
			};
		}
		else {
			return {
				result: values[0].value,
				type: 'number',
				variablesReference: 0
			};
		}
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) 
	{
		if (args.context == 'repl') {
			let expression = args.expression;
			if (expression == '') {
				expression = this.lastExpression;
			}

			const cmd = decodeRWCommand(expression, this.currFilename, this.currLine, this.refMgr);
			if (cmd.type == 'dumpbin') {
				let res = this.client.readMemory(cmd.addr, cmd.lengthOrValue);
				if (res.ok) {
					let data = new Uint8Array(res.bytes.length);
					for (let i=0; i<res.bytes.length; i++) {
						data[i] = res.bytes[i];
					}
					if (!path.isAbsolute(cmd.toFile) && path.isAbsolute(this._rootPath)) {
						cmd.toFile = path.join(this._rootPath, cmd.toFile);
					}

					fs.writeFileSync(cmd.toFile, data, {encoding:null});
				}
				else {
					throw res.reason;
				}
			}
			else if (cmd.type != 'invalid') {
				try {
					if (cmd.type == 'read') {
						let rowbytes = vscode.workspace.getConfiguration().get<number>('upasm.debugger.rowbytes');
						if (rowbytes == undefined || rowbytes % cmd.step != 0) {
							rowbytes = 32;
						}
						let res = this.client.readMemory(cmd.addr, cmd.lengthOrValue);
						if (res.ok) {
							let codes:number[];
							let n = res.bytes.length/cmd.step;
							if (cmd.step == 1) {
								codes = res.bytes;
							}
							else {
								codes = [];
								for (let i=0; i<n; i++) {
									switch(cmd.step) {
									case 4: codes.push(bytes_2_word(res.bytes, i*4)); break;
									case 2: codes.push(bytes_2_short(res.bytes, i*2)); break;
									}
								}
							}
							let result = '', appendText = '';

							switch(cmd.hex_or_dec) {
							case 'hex':
								for (let i=0; i<codes.length; i++) {
									let text = padZero(codes[i], cmd.step*2, 16) + ' '; 
									result += text;
									appendText += text;
									if ((i + 1) % (rowbytes/cmd.step) == 0) {
										result += '\n';
									}
								}
								break;

							case 'dec':
								for (let i=0; i<codes.length; i++) {
									let v = suppression(codes[i], Math.pow(2, cmd.step*8-1)-1);
									let text = padZero(v, cmd.step*3, 10, ' ') + ' '; 
									result += text;
									appendText += text;
									if ((i + 1) % (rowbytes/cmd.step) == 0) {
										result += '\n';
									}
								}
								break;

							case 'float':
								for (let i=0; i<codes.length; i++) {
									let text = hex2float_str(codes[i]) + ' ';
									result += text;
									appendText += text;
									if ((i + 1) % (rowbytes/4) == 0) {
										result += '\n';
									}
								}
								break;
							}
							if (cmd.toFile.length > 0) {
								if (!path.isAbsolute(cmd.toFile) && path.isAbsolute(this._rootPath)) {
									cmd.toFile = path.join(this._rootPath, cmd.toFile);
								}
								if (cmd.append) {
									fs.appendFileSync(cmd.toFile, appendText + '\n');
								}
								else {
									fs.writeFileSync(cmd.toFile, result);
								}
							}
							response.body = {
								result: result,
								type: 'string',
								variablesReference: 0
							};
						}
						else {
							throw res.reason;
						}
					}
					else {
						let bytes:number[] = [];
						switch(cmd.step) {
						case 4: bytes = word_2_bytes(cmd.lengthOrValue); break;
						case 2: bytes = short_2_bytes(cmd.lengthOrValue); break;
						case 1: bytes = [cmd.lengthOrValue]; break;
						}

						let res = this.client.writeMemory(cmd.addr, bytes);
						if (res.ok) {
							response.body = {
								result: 'Write done',
								type: 'string',
								variablesReference: 0
							};
						}
						else {
							throw res.reason;
						}						
					}
				} catch (error) {
					response.body = {
						result: error as string,
						type: 'string',
						variablesReference: 0
					};
				}
				this.lastExpression = expression;
			}
		}
		else if (args.context == 'watch' || args.context == 'hover') {
			response.body = this.setEvaluateResponseBody(response, args.expression);
		}
		this.sendResponse(response);
	}
}