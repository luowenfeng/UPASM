import { IBuildInfo, IConfigInfo } from "./UpasmClient";
import { REG256_REF_ID } from "./UpasmDebugSession";
import { IUpasmData, UpasmWatcher } from "./UpasmWatcher";


interface IDataFormat {
	step:1|2|4;
	hex:boolean;
	signed:boolean;
};

export function decodeDataFormat(text:string)
{
	let fmt:IDataFormat = {step:4, hex:true, signed:false};
	if (text.length != 3) {
		throw new Error('Format should contain 3 letters.');
	}

	switch(text[0]) {
	case 'w': fmt.step = 4; break;
	case 's': fmt.step = 2; break;
	case 'b': fmt.step = 1; break;
	default: throw new Error('First letter for format should be w|s|b.');
	}

	switch(text[1]) {
	case 'h': fmt.hex = true; break;
	case 'd': fmt.hex = false; break;
	default: throw new Error('Second letter for format should be h|d.');
	}

	switch(text[2]) {
	case 's': fmt.signed = true; break;
	case 'u': fmt.signed = false; break;
	default: throw new Error('Third letter for format should be u|s.');
	}
	return fmt;
}

export function parseValue(value:string, format:IDataFormat)
{
	let v = parseInt(value, format.hex ? 16 : 10);		
	if (isNaN(v)) {
		throw new Error('Invalid number "' + value + '"');
	}

	let maxv = 0xffffffff;
	let minv = 0;
	switch(format.step) {
	case 4:	maxv = 0xffffffff; break;
	case 2: maxv = 0xffff; break;
	case 1: maxv = 0xff; break;
	}

	if (format.signed) {
		maxv = maxv / 2;
		minv = - maxv - 1;		
	}

	if (v > maxv || v < minv) {
		throw new Error('"' + value + '" is out of Range(' + minv + '~' + maxv + ')');
	}

	return v;
}

const max_uint32 = 4294967295; // 0xffffffff
function unsigned_word(v:number)
{
	if (v > max_uint32) {
		v = max_uint32;
	}
	else if (v < 0) {
		while(v < 0) {
			v = max_uint32 + 1 + v;
		}
		if (v > max_uint32) {
			v = max_uint32;
		}
	}
	return v;
}

export function word_2_bytes(v:number)
{
	v = unsigned_word(v);
	return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

const max_uint16 = 65535; // 0xffff
function unsigned_short(v:number) 
{
	if (v > max_uint16) {
		v = max_uint16;
	}
	else if (v < 0) {
		while(v < 0) {
			v = max_uint16 + 1 + v;
		}
		if (v > max_uint16) {
			v = max_uint16;
		}
	}
	return v;
}

export function short_2_bytes(v:number)
{
	v = unsigned_short(v);
	return [v & 0xff, (v >> 8) & 0xff];
}

const max_uint8 = 255; // 0xff
function unsigned_byte(v:number) 
{
	if (v > max_uint8) {
		v = max_uint8;
	}
	else if (v < 0) {
		while(v < 0) {
			v = max_uint8 + 1 + v;
		}
		if (v > max_uint8) {
			v = max_uint8;
		}
	}
	return v;
}


export function parseValueBytes(value:string, format:IDataFormat)
{
	let v = parseValue(value, format);
	let bytes:number[];
	switch(format.step) {
	case 4:	bytes = word_2_bytes(v); break;
	case 2: bytes = short_2_bytes(v); break;
	case 1: bytes = [unsigned_byte(v)]; break;
	}
	return bytes;
}

export function bytes_2_word(bytes:number[], idx?:number)
{
	if (idx == undefined) {
		idx = 0;
	}
	return bytes[idx] + (bytes[idx+1] + (bytes[idx+2] + bytes[idx+3]*256)*256)*256;
}

export function bytes_2_short(bytes:number[], idx?:number)
{
	if (idx == undefined) {
		idx = 0;
	}
	return bytes[idx] + (bytes[idx+1])*256;
}

export function padZero(num:number, size:number, radix:number, padChar:string = '0') : string {
	let str = '';
	if (num != undefined) {
		str = (num).toString(radix).toUpperCase();
		while (str.length < size) str = padChar + str;
	}
	else {
		throw new Error('Invalid number: ' + num);
	}
	return str;
}

export class UpasmReference
{
	public readonly isRegister:boolean;
	public readonly data:IUpasmData;
	public readonly refID:number;
	public readonly fmtText:string;
	public readonly format:IDataFormat;

	constructor(isRegister:boolean, data:IUpasmData, refID:number, fmtText:string = 'whu')
	{
		this.isRegister = isRegister
		this.data = data;
		this.refID = refID;
		this.fmtText = fmtText;
		this.format = decodeDataFormat(fmtText);
	}

	public get values() {
		let codes = [];
		let bytes = this.data.bytes;
		const n = this.format.step*2;
		switch(this.format.step) {
		case 4:
			for (let i=0; i<bytes.length; i+=4) {
				let v = bytes_2_word(bytes, i);
				if (this.format.signed) {
					v = unsigned_word(v);
				}
				codes.push(v);
			}
			break;

		case 2:
			for (let i=0; i<bytes.length; i+=2) {
				let v = bytes_2_short(bytes, i);
				if (this.format.signed) {
					v = unsigned_short(v);
				}
				codes.push(v);
			}
			break;

		case 1:
			for (const b of this.data.bytes) {
				let v = b;
				if (this.format.signed) {
					v = unsigned_byte(v);
				}
				codes.push(v);
			}
			break;
		}

		let values = [];
		let prefix:'b'|'s'|'w';
		switch(this.format.step) {
		case 1: prefix = 'b'; break;
		case 2: prefix = 's'; break;
		case 4: prefix = 'w'; break;
		}
		let i = 0;
		if (this.format.hex) {
			for (const c of codes) {
				values.push({name:prefix + i, value:'0x' + padZero(c, n, 16)});
				i++;
			}
		}
		else {
			for (const c of codes) {
				values.push({name:prefix + i, value:c.toString(10)});
				i++;
			}
		}
		return values;
	}
}

export interface IUpasmRefKey
{
	isRegister:boolean;
	addrOrIdx:number;
	length:number;
	format:string;
	text:string;
}

export class UpasmReferenceManager 
{
	private buildInfo:IBuildInfo;
	private configInfo:IConfigInfo;
	private watcher:UpasmWatcher;
	private refID = REG256_REF_ID + 1;
	private refTextMap = new Map<string, UpasmReference>();
	private refIdxMap = new Map<number, string>();

	public get reg32Count() { return this.watcher.reg32Count; };
	public get reg64Count() { return this.watcher.reg64Count; };
	public get reg128Count() { return this.watcher.reg128Count; };
	public get reg256Count() { return this.watcher.reg256Count; };

	constructor(watcher:UpasmWatcher, configInfo:IConfigInfo, buildInfo:IBuildInfo)
	{
		this.watcher = watcher;
		this.buildInfo = buildInfo;
		this.configInfo = configInfo;
		for (const reg of watcher.regs) {
			let ref = new UpasmReference(true, reg, this.refID++);
			let name = 'r' + reg.idxOrAddr + ' whu';
			this.refIdxMap.set(ref.refID, name);
			this.refTextMap.set(name, ref);
		}
	}

	public updateWatcher()
	{
		this.watcher.updateRead();
	}

	public getRefByID(id:number)
	{
		let name = this.refIdxMap.get(id);
		if (name) {
			return this.refTextMap.get(name);
		}
		return undefined;
	}

	public getGlobalSymbol(name:string)
	{
		return this.buildInfo.symbols.get(name)
	}

	private checkMacro(filename:string, name:string)
	{
		let asmInfo = this.buildInfo.files.get(filename);
		if (asmInfo == undefined) {
			asmInfo = this.buildInfo.lowerFiles.get(filename);
		}

		if (asmInfo) {
			let value = asmInfo.macros.get(name);
			if (value) {
				return value;
			}
		}
		return name;
	}

	private checkRegister(filename:string, name:string)
	{
		name = this.checkMacro(filename, name);
		// check alias
		let value = this.configInfo.regAlias.get(name);
		if (value) {
			name = value;
		}

		if (name[0] == 'r') {
			let v = Number.parseInt(name.substring(1), 10);
			if (v >= 0) {
				return v;
			}
		}
		return -1;
	}
	

	private getSymbolAddr(filename:string, symbolname:string)
	{
		let addr = -1;
		let asmInfo = this.buildInfo.files.get(filename);
		if (asmInfo == undefined) {
			asmInfo = this.buildInfo.lowerFiles.get(filename);
		}
		if (asmInfo) {
			let value = asmInfo.macros.get(symbolname);
			if (value) {
				symbolname = value;
			}
			let v = asmInfo.vars.get(symbolname);
			if (v) {
				addr = v;
			}
		}
		return addr;
	}

	private decodeExpression(filename:string, expression:string)
	{
		let key:IUpasmRefKey = {isRegister:false, addrOrIdx:-1, length:0, format:'whu', text:''};
		let parts = expression.split(' ').filter(item => item != '');
		if (parts.length <= 0 || parts.length > 3) {
			throw new Error('Bad expression: ' + expression);
		}

		let v = this.checkRegister(filename, parts[0]);
		if (v >= 0) {
			let ref = this.refTextMap.get('r' + v + ' whu');
			if (ref) {
				key.isRegister = true;
				key.addrOrIdx = v;
				key.length = ref?.data.bytes.length;
				if (parts.length == 2) {
					key.format = parts[1];
				}
				key.text = 'r' + key.addrOrIdx +' ' + key.format;
			}
		}
		else if (parts.length >= 2) {
			let offset = 0;
			let symName = parts[0];
			let sparts = parts[0].split('+');
			if (sparts.length == 2) {
				symName = sparts[0];
				offset = Number.parseInt(sparts[1]);
			}
	
			if (offset >= 0) {
				let addr = this.getSymbolAddr(filename, symName);
				if (addr >= 0) {
					key.addrOrIdx = addr + offset;
				}
				else {
					key.addrOrIdx = Number.parseInt(parts[0]);
				}
				key.length = Number.parseInt(parts[1]);

				if (parts.length == 3) {
					key.format = parts[2];
				}

				if (key.addrOrIdx >= 0) {
					key.text = '0x' + padZero(key.addrOrIdx, 8, 16) + ' ' + key.length + ' ' + key.format;
				}
			}
		}

		return key;
	}

	public getRegister(idx:number) {
		return this.refTextMap.get('r'+idx + ' whu');
	}

	public getReg32(idx:number) {
		return this.watcher.regs[idx];
	}

	public watchExpression(filename:string, expression:string)
	{
		let key = this.decodeExpression(filename, expression);
		if (key.text == '') {
			throw new Error('Invalid expression "' + expression + '"');
		}

		let ref = this.refTextMap.get(key.text);
		if (ref == undefined) {
			if (key.isRegister) {
				ref = new UpasmReference(true, this.watcher.regs[key.addrOrIdx], this.refID, key.format); // 这里可能抛出异常, this.refID++写下面
			}
			else {
				let mem = this.watcher.watchMemory(key.addrOrIdx, key.length);
				ref = new UpasmReference(false, mem, this.refID, key.format);	// 这里可能抛出异常, this.refID++写下面
			}

			this.refID++;
			this.refIdxMap.set(ref.refID, key.text);
			this.refTextMap.set(key.text, ref);
		}
		return ref;	
	}
}