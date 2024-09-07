import * as ref from 'ref-napi'
import * as ffi from 'ffi-napi'
import * as path from 'path';
import { clearInterval } from 'timers';
import { RegMap } from './UpasmExt';

export interface ITokenInfo {
	start:number;
	length:number;
	type:string;
	refText:string;
	refFilename:string;
	refLineNum:number;
}

export interface ILineInfo {
	lineNum:number;
	textLen:number;
	tokens:ITokenInfo[];
	type:string;
	decoText:string;
	errors:string[];
}

export interface IVariableInfo {
	name:string;
	addr:number;
}

export interface INameRef {
	content:string;
	type:string;
	start:number;
	end:number;
	refFile:string;
	refLine:number;
}

export interface IAsmInfo {
	filename:string;
	lines:Map<number,ILineInfo>;	
	nameMap:Map<string, INameRef[]>;
};

export interface IConfigInfo {
	configFile:string;
	reg32Count:number;
	regAlias:Map<string, string>;
	regMaps:RegMap[];
	regAddrs:Map<number, number>;
};

function decodeAsmInfo(json:any) 
{
	let asmInfo:IAsmInfo = {filename:json.filename, lines:new Map<number,ILineInfo>(), nameMap:new Map<string, INameRef[]>()};
	for (const line of json.lines) {
		let l:ILineInfo = {lineNum:line.lineNum, textLen:line.textLen, type:line.type, decoText:line.infoText, tokens:[], errors:[]}
		for (const token of line.tokens) {
			let tk:ITokenInfo = {start:token.start, length:token.length, type:token.type, refText:"", refFilename:"", refLineNum:-1};
			if (token.refText) {
				tk.refText = token.refText;
				tk.refFilename = token.refFilename;
				tk.refLineNum = token.refLineNum;
			}
			l.tokens.push(tk);
		}
		l.errors = line.errors;		
		asmInfo.lines.set(l.lineNum, l);
	}
	for (const nmap of json.nameMap) {
		let nameRefs:INameRef[] = [];
		for (const ref of nmap.refs) {
			let nameRef:INameRef = {content:ref.content, type:ref.type, start:ref.start, end:ref.end, refFile:ref.refFile, refLine:ref.refLine};
			nameRefs.push(nameRef);
		}		
		asmInfo.nameMap.set(nmap.name, nameRefs);
	}

	return asmInfo;
}

function decodeConfigInfo(json:any) : IConfigInfo
{
	let regAlias = new Map<string, string>();
	for (const pair of json.regAlias) {
		regAlias.set(pair.name, pair.value);
	}
	let regMaps:RegMap[] = [];
	for (const jsonMap of json.regMaps) {
		let regMap = {idx:jsonMap.idx, mapTo:jsonMap.mapTo, offsetBit:jsonMap.offsetBit, bitLen:jsonMap.bitLen};
		regMaps.push(regMap);
	}

	let regAddrs = new Map<number, number>();
	for (const regAddr of json.regAddrs) {
		regAddrs.set(regAddr.idx, regAddr.addr);
	}

	return {configFile:json.configFile as string, reg32Count:json.reg32Count as number, regAlias:regAlias, regMaps:regMaps, regAddrs:regAddrs};
}


export interface IBuildInfo {
	files:Map<string, IAsmInfo>;
	lowerFiles:Map<string, IAsmInfo>;
	symbols:Map<string, number>;
	cfg:IConfigInfo;
	errors:string[];

};

export function getNameRef(buildInfo:IBuildInfo, filename:string, line:number, name:string) :INameRef|undefined
{
	try {
		let file = buildInfo.files.get(filename);
		if (file != undefined) {
			let nameRefs = file.nameMap.get(name);
			if (nameRefs != undefined) {
				for (const nameRef of nameRefs) {
					if (line >= nameRef.start && (nameRef.end < 0 || line <= nameRef.end)) {
						if (nameRef.type == "macro") {
							return getNameRef(buildInfo, filename, line, nameRef.content);
						}
						return nameRef;
					}
				}
			}
		}
		let nameRef:INameRef|undefined = undefined;
		let reg = buildInfo.cfg.regAlias.get(name);
		if (reg != undefined) {
			nameRef = {content:reg, type:"reg", start:0, end:-1, refFile:"Global config", refLine:-1};
			return nameRef;
		}
	
		let addr = buildInfo.symbols.get(name);
		if (addr != undefined) {
			nameRef = {content:"0x" + addr.toString(16), type:"symbol", start:0, end:-1, refFile:"Global symbol", refLine:-1};
		}
	}
	catch(error) {
		console.log(error);
	}
	

	return undefined;
}


function decodeBuildInfo(json:any)
{
	let buildInfo:IBuildInfo = {
		files:new Map<string, IAsmInfo>(), 
		lowerFiles:new Map<string, IAsmInfo>(), 
		symbols:new Map<string, number>(),
		errors:[], 
		cfg:decodeConfigInfo(json.configInfo)
	};
	for (const file of json.fileInfo) {
		let asmInfo = decodeAsmInfo(file);
		buildInfo.files.set(asmInfo.filename, asmInfo);
		buildInfo.lowerFiles.set(asmInfo.filename.toLowerCase(), asmInfo);
	}
	if (json.result == true) {
		buildInfo.errors = json.buildErrors;
		for(const pair of json.globalSymbols) {
			buildInfo.symbols.set(pair.name, pair.addr);
		}
	}
	return buildInfo;
}


class UpasmInstWrap {
	private constructor(dll: {
		UPASMInst_Create: ffi.ForeignFunction<ref.Pointer<unknown>, [string]>;
		UPASMInst_Destroy: ffi.ForeignFunction<void, [ref.Pointer<unknown>]>;
		UPASMInst_ProcessCommand: ffi.ForeignFunction<string | null, [ref.Pointer<unknown>, string]>;
		UPASMInst_LockMessage: ffi.ForeignFunction<void, [ref.Pointer<unknown>]>;
		UPASMInst_GetMessage: ffi.ForeignFunction<string|null, [ref.Pointer<unknown>]>;
		UPASMInst_UnlockMessage: ffi.ForeignFunction<void, [ref.Pointer<unknown>]>;
	}, inst:ref.Pointer<unknown>)
	{
		this.dll = dll;
		this.inst = inst;
	}

	public static create(extensionPath:string) {
		const LIB_FILE = (() => {
			switch (process.platform) {
			case 'darwin': return 'libUPASM.dylib';
			case 'linux': return 'libUPASM.so';
			case 'win32': return 'libUPASM.dll';
			default: return 'UNKNOWN-platform';
			}
		})();

		const libpath = path.resolve(extensionPath, 'lib', process.platform, process.arch, LIB_FILE);
		if (process.platform == 'win32') {
			const kernel32 = ffi.Library('kernel32', {
				'SetDllDirectoryA': ['bool', ['string']],
			});
			kernel32.SetDllDirectoryA(path.dirname(libpath));
		}
		let dll = ffi.Library(libpath, {
			'UPASMInst_Create':['void*', ['string']],
			'UPASMInst_Destroy':['void', ['void*']],
			'UPASMInst_ProcessCommand':['string', ['void*', 'string']],
			'UPASMInst_LockMessage':['void', ['void*']],
			'UPASMInst_GetMessage':['string', ['void*']],
			'UPASMInst_UnlockMessage':['void', ['void*']],
		});
		
		let inst = dll.UPASMInst_Create(extensionPath);
		if (inst == null) {
			throw new Error("UPASMInst_Create failed...");
		}

		return new UpasmInstWrap(dll, inst);
	}

	dispose() {
		this.dll.UPASMInst_Destroy(this.inst)
	}

	processCommand(obj:any)
	{
		let text = JSON.stringify(obj);
		return this.dll.UPASMInst_ProcessCommand(this.inst, text);
	}

	getMessages() {
		let messages = [];
		this.dll.UPASMInst_LockMessage(this.inst);
		while(true) {
			let msg = this.dll.UPASMInst_GetMessage(this.inst);
			if (msg != null) {
				messages.push(msg);
			}
			else {
				break;
			}
		}
		this.dll.UPASMInst_UnlockMessage(this.inst);
		return messages;
	}

	private dll;
	private inst;
}

export interface IUpasmDebuggerListener {
	onDebugEror(err:string):void;
	onDebugEnd(msg:string):void;
	onDebugMessage(msg:string):void;
	onDebugPause(filename:string, lineNum:number):void;
}


export class UpasmClient {
	// public buildInfo?:IBuildInfo;
	private inst;
	private dbgInterval?:NodeJS.Timeout;
	private _dbgListener?:IUpasmDebuggerListener;
	public set debugListener(dbg:IUpasmDebuggerListener) {this._dbgListener = dbg;}

	public constructor(extensionPath:string) {
		this.inst = UpasmInstWrap.create(extensionPath);
	}

	public dispose()
	{
		this.inst.dispose();
	}

	openWorkspace(workspace:string, projfile:string) : {buildInfo?:IBuildInfo, reason:string} {
		try {
			let request = {method:'openWorkspace', workspace:workspace, projfile:projfile};
			let result = JSON.parse(this.inst.processCommand(request)!);
			if (result.configInfo == undefined) {
				return {buildInfo:undefined, reason:result.reason as string};
			}

			const ok = result.result as boolean;
			if (ok) {
				return {buildInfo:decodeBuildInfo(result), reason:''};
			}
			else {
				return {buildInfo:decodeBuildInfo(result), reason:result.reason as string};
			}
		} catch (error) {
			console.log(error);
			return {buildInfo:undefined, reason:error as string};
		}
	}

	getFile(filename:string) : {fileInfo?:IAsmInfo, reason:string} {		
		let request = {method:'getFile', filename:filename};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {fileInfo:decodeAsmInfo(result.asmInfo), reason:''};
		}
		else {
			return {fileInfo:undefined, reason:result.reason as string};			
		}
	}

	updateFile(filename:string, content:string) : {ok:boolean, reason:string, buildErrors:string[], fileInfo?:IAsmInfo} {
		let request = {method:'updateFile', filename:filename, content:content};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {ok:true, reason:'', buildErrors:result.buildErrors, fileInfo:decodeAsmInfo(result.asmInfo)};
		}
		else {
			return {ok:false, reason:result.reason as string, buildErrors:[], fileInfo:undefined};			
		}
	}

	reloadFile(filename:string): {ok:boolean, reason:string, buildErrors:string[]} {
		let request = {method:'reloadFile', filename:filename};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {ok:true, reason:'', buildErrors:result.buildErrors};
		}
		else {
			return {ok:false, reason:result.reason as string, buildErrors:[]};			
		}
	}

	rebuild() : {buildInfo?:IBuildInfo, reason:string} {		
		let request = {method:'rebuild'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {buildInfo:decodeBuildInfo(result), reason:result.errors as string};
		}
		else {
			return {buildInfo:undefined, reason:result.reason as string};
		}
	}

	output() {
		let request = {method:'output'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {ok:true, files:result.files, reason:''};
		}
		else {
			return {ok:false, files:'', reason:result.reason as string};
		}
	}

	gensource(srcfile:string) {
		let request = {method:'gensource', srcfile:srcfile};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {ok:true, incname:result.incname as string, asmname:result.asmname as string, reason:''};
		}
		else {
			return {ok:false, incname:'', asmname:'', reason:result.reason as string};
		}
	}

	countInstructions(file:string, start:number, end:number) {
		let request = {method:'countInstructions', filename:file, start:start, end:end};
		return JSON.parse(this.inst.processCommand(request)!);
	}

	private onDebugStarted()
	{
		this.dbgInterval = setInterval(()=>{
			const msgs = this.inst.getMessages();
			for (const msg of msgs) {
				const msgJS = JSON.parse(msg);
				switch(msgJS.responseTo as string) {
				case 'debugEvent-error':
					this._dbgListener?.onDebugEror(msgJS.message);
					this.onDebugStopped();
					break;
				case 'debugEvent-end':
					this._dbgListener?.onDebugEnd(msgJS.message);
					this.onDebugStopped();					
					break;
				case 'debugEvent-pause':
					this._dbgListener?.onDebugPause(msgJS.filename, msgJS.lineNum);
					break;
				case 'debugEvent-message':
					this._dbgListener?.onDebugMessage(msgJS.message);
					break;
				}
			}
		}, 100);
	}

	private onDebugStopped()
	{
		if (this.dbgInterval) {
			clearInterval(this.dbgInterval);
			this.dbgInterval = undefined;
		}
		
	}

	//#region DEBUGGER
	startDebug()
	{
		let request = {method:'startDebug'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			this.onDebugStarted();
			return {
				ok:true, 
				reason:'',
				regCount:result.regCount as number[],
				filename:result.filename as string,
				lineNum:result.lineNum as number,
				useSimulator:false,
				simFilepath:""
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				regCount:[],
				filename:'',
				lineNum:0,
				useSimulator:false,
				simFilepath:""
			};
		}
	}

	restartDebug()
	{
		let request = {method:'restartDebug'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			this.onDebugStarted();
			return {
				ok:true, 
				reason:'',
				reg32Count:result.reg32Count as number, 
				reg64Count:result.reg64Count as number, 
				reg128Count:result.reg128Count as number, 
				reg256Count:result.reg256Count as number, 
				filename:result.filename as string,
				lineNum:result.lineNum as number
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				reg32Count:0, 
				reg64Count:0, 
				reg128Count:0, 
				reg256Count:0, 
				filename:'',
				lineNum:0
			};
		}
	}

	stepDebug()
	{
		let request = {method:'stepDebug'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
				filename:result.filename as string,
				lineNum:result.lineNum as number
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				filename:'',
				lineNum:0
			};
		}
	}

	stepbackDebug()
	{
		let request = {method:'stepbackDebug'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
				filename:result.filename as string,
				lineNum:result.lineNum as number
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				filename:'',
				lineNum:0
			};
		}
	}

	continueDebug()
	{
		let request = {method:'continueDebug'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
			};
		}
	}

	pauseDebug()
	{
		let request = {method:'pauseDebug'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
				filename:result.filename as string,
				lineNum:result.lineNum as number
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				filename:'',
				lineNum:0
			};
		}
	}

	stopDebug()
	{
		let request = {method:'stopDebug', needResponse:true};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			this.onDebugStopped();
			this._dbgListener?.onDebugEnd(result.message);
			return {
				ok:true, 
				reason:'',
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
			};
		}
	}

	setBreakpoints(filename:string, lines:number[])
	{
		let request = {method:'setBreakpoints', filename:filename, lines:lines};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
				filename:result.filename as string,
				lines:result.lines as number[]
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				filename:'',
				lines:[]
			};
		}
	}

	readRegisters()
	{
		let request = {method:'readRegisters'};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
				bytes:result.bytes as number[],
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				bytes:[]
			};
		}
	}

	writeRegister(idx:number, bytes:number[])
	{
		let request = {method:'writeRegister', idx:idx, bytes:bytes};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
			};
		}
	}

	readMemory(addr:number, length:number)
	{
		let request = {method:'readMemory', addr:addr, length:length};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
				addr:result.addr as number,
				bytes:result.bytes as number[],
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
				addr:0,
				bytes:[]
			};
		}
	}

	writeMemory(addr:number, bytes:number[])
	{
		let request = {method:'writeMemory', addr:addr, bytes:bytes};
		let result = JSON.parse(this.inst.processCommand(request)!);
		const ok = result.result as boolean;
		if (ok) {
			return {
				ok:true, 
				reason:'',
			};
		}
		else {
			return {
				ok:false, 
				reason:result.reason as string,
			};
		}
	}
	//#endregion
}