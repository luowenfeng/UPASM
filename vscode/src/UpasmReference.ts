import { IBuildInfo, IConfigInfo, getNameRef } from "./UpasmClient";
import { REG256_REF_ID } from "./UpasmDebugSession";
import { IUpasmData, UpasmWatcher } from "./UpasmWatcher";


interface IDataFormat {
	step:1|2|4;
	type:'hex'|'singed_decimal'|'unsigned_decimal'|'float';
};

export function decodeDataFormat(text:string)
{
	let fmt:IDataFormat = {step:4, type:'hex'};
	if (text == 'f') {
		fmt.step = 4;
		fmt.type = 'float';
		return fmt;
	}
	if (text.length != 2) {
		throw new Error('Format should contain 2 letters.');
	}

	switch(text[0]) {
	case 'w': fmt.step = 4; break;
	case 's': fmt.step = 2; break;
	case 'b': fmt.step = 1; break;
	default: throw new Error('First letter for format should be w|s|b.');
	}

	switch(text[1]) {
	case 'h': fmt.type = 'hex'; break;
	case 'u': fmt.type = 'unsigned_decimal'; break;
	case 's': fmt.type = 'singed_decimal'; break;
	default: throw new Error('Second letter for format should be h|u|s.');
	}

	return fmt;
}

export function parseValue(value:string, format:IDataFormat)
{
	if (format.type == 'float') {
		return parseFloat(value);
	}

	let v = parseInt(value, format.type == 'hex' ? 16 : 10);
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

	if (format.type == 'singed_decimal') {
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

const max_int32 = 2147483647; // 0x7FFFFFFF
function signed_word(v:number)
{
	if (v > max_int32) {
		v = -(max_uint32 + 1 - v);
	}
	return v;
}

const max_int16 = 32767; // 0x7FFF
function signed_short(v:number)
{
	if (v > max_int16) {
		v = -(max_uint16 + 1 - v);
	}
	return v;
}

const max_int8 = 127; // 0x7F
function signed_byte(v:number)
{
	if (v > max_int8) {
		v = -(max_uint8 + 1 - v);
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

function hex2float(num:number) {
	if (num == 0) return 0;

	var float = 0;
    var sign = (num & 0x80000000) ? -1 : 1;
    var exp = ((num >> 23) & 0xff) - 127;
    var mantissa = ((num & 0x7fffff) + 0x800000).toString(2);
	for (let i=0; i<mantissa.length; i+=1){
		float += parseInt(mantissa[i])? Math.pow(2,exp):0;
		exp--;
	}
    return (sign * float);
}

export class UpasmReference
{
	public readonly isRegister:boolean;
	public readonly data:IUpasmData;
	public readonly refID:number;
	public readonly fmtText:string;
	public readonly format:IDataFormat;

	constructor(isRegister:boolean, data:IUpasmData, refID:number, fmtText:string = 'wh')
	{
		this.isRegister = isRegister;
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
				if (this.format.type == 'singed_decimal') {
					v = signed_word(v);
				}
				else if (this.format.type == 'float') {
					v = hex2float(v);
				}
				codes.push(v);
			}
			break;

		case 2:
			for (let i=0; i<bytes.length; i+=2) {
				let v = bytes_2_short(bytes, i);
				if (this.format.type == 'singed_decimal') {
					v = signed_short(v);
				}
				codes.push(v);
			}
			break;

		case 1:
			for (const b of this.data.bytes) {
				let v = b;
				if (this.format.type == 'singed_decimal') {
					v = signed_byte(v);
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
		if (this.format.type == 'hex') {
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

interface IRegMapInfo {
	idx:number;
	bit_start:number;
	bit_len:number;
}

export class UpasmReferenceManager 
{
	private buildInfo:IBuildInfo;
	private watcher:UpasmWatcher;
	private refID = REG256_REF_ID + 1;
	private refTextMap = new Map<string, UpasmReference>();
	private refIdxMap = new Map<number, string>();
	private regMap = new Map<number, IRegMapInfo>();
	private _regs = new Array<IUpasmData>();

	public get reg32Count() { return this.watcher.reg32Count; };
	public get reg64Count() { return this.watcher.reg64Count; };
	public get reg128Count() { return this.watcher.reg128Count; };
	public get reg256Count() { return this.watcher.reg256Count; };

	constructor(watcher:UpasmWatcher, configInfo:IConfigInfo, buildInfo:IBuildInfo)
	{
		this.watcher = watcher;
		this.buildInfo = buildInfo;
		for (const reg of watcher.regs) {
			let ref = new UpasmReference(true, reg, this.refID++);
			let name = 'r' + reg.idxOrAddr + ' wh';
			this.refIdxMap.set(ref.refID, name);
			this.refTextMap.set(name, ref);
		}

		for (const m of configInfo.regMaps) {
			this.regMap.set(m.idx, {idx:m.mapTo, bit_start:m.offsetBit, bit_len:m.bitLen});
		}

		this._regs = [...this.watcher.regs];
		for (const m of this.regMap) {
			let src = this._regs[m[1].idx];
			this._regs.push({idxOrAddr:m[0], bytes:src.bytes.slice(m[1].bit_start/8, (m[1].bit_start+m[1].bit_len)/8)});
		}
	}

	public updateWatcher()
	{
		this.watcher.updateRead();
		// 更新映射寄存器
		let i = this.watcher.regs.length;
		for (; i<this._regs.length; i++) {			
			let m = this.regMap.get(i)!;
			let src = this.watcher.regs[m.idx];
			for (let j=0; j<m.bit_len/8; j++) {
				this._regs[i].bytes[j] = src.bytes[m.bit_start/8+j];
			}			
		}
	}

	public getRefByID(id:number)
	{
		let name = this.refIdxMap.get(id);
		if (name) {
			return this.refTextMap.get(name);
		}
		return undefined;
	}

	public getNamedValue(filename:string, line:number, name:string)
	{
		let nameRef = getNameRef(this.buildInfo, filename, line, name);
		if (nameRef != undefined) {
			switch(nameRef.type) {
			case "reg": 
			case "func_reg":
				return this.buildInfo.cfg.regAddrs.get(parseInt(nameRef.content.substring(1)));
				
			case "var": 
			case "symbol": 
				return parseInt(nameRef.content);

			case "func_var": break;
			}
		}	
				
		return undefined;
	}

	private checkRegister(filename:string, line:number, name:string)
	{
		if (name[0] == 'r') {
			let v = parseInt(name.substring(1));
			if (v >= 0) {
				return v;
			}
		}

		let nameRef = getNameRef(this.buildInfo, filename, line, name);
		if (nameRef != undefined && (nameRef.type == "reg" || nameRef.type == "func_reg")) {
			let v = Number.parseInt(nameRef.content.substring(1), 10);
			if (v >= 0) {
				return v;
			}
		}
		return -1;
	}
	
	private decodeExpression(filename:string, line:number, expression:string)
	{
		let key:IUpasmRefKey = {isRegister:false, addrOrIdx:-1, length:0, format:'wh', text:''};
		let parts = expression.split(' ').filter(item => item != '');
		if (parts.length <= 0 || parts.length > 3) {
			throw new Error('Bad expression: ' + expression);
		}

		let v = this.checkRegister(filename, line, parts[0]);
		if (v >= 0) {
			if (parts.length == 2) {
				key.format = parts[1];
			}
			// 检查是否为映射寄存器
			let m = this.regMap.get(v);
			if (m) {
				key.isRegister = true;
				key.addrOrIdx = v;
				key.length = m.bit_len / 8;
				key.text = 'r' + v + ' ' + key.format;
			}
			else {
				// 普通寄存器
				let ref = this.refTextMap.get('r' + v + ' wh');
				if (ref) {
					key.isRegister = true;
					key.addrOrIdx = v;
					key.length = ref?.data.bytes.length;
					key.text = 'r' + key.addrOrIdx +' ' + key.format;
				}
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
				let addr = this.getNamedValue(filename, line, symName);
				if (addr != undefined && !isNaN(addr) && addr >= 0) {
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
		return this.refTextMap.get('r'+idx + ' wh');
	}

	public getReg32(idx:number) {
		return this.watcher.regs[idx];
	}

	public watchExpression(filename:string, line:number, expression:string)
	{
		let key = this.decodeExpression(filename, line, expression);
		if (key.text == '') {
			throw new Error('Invalid expression "' + expression + '"');
		}

		let ref = this.refTextMap.get(key.text);
		if (ref == undefined) {
			let data:IUpasmData|undefined = undefined;
			if (key.isRegister) {
				data = this._regs[key.addrOrIdx];
			} else {
				data = this.watcher.watchMemory(key.addrOrIdx, key.length);
			}

			ref = new UpasmReference(key.isRegister, data, this.refID, key.format);	// 这里可能抛出异常, this.refID++写下面
			this.refID++;
			this.refIdxMap.set(ref.refID, key.text);
			this.refTextMap.set(key.text, ref);
		}
		return ref;	
	}
}