import { UpasmClient } from "./UpasmClient";

export interface IUpasmData {
	idxOrAddr:number;
	bytes:number[];
}

export interface IUpasmMemory {
	addr:number;
	bytes:number[];
}

export class UpasmWatcher {
	private client;
	private _regs = new Array<IUpasmData>();
	private _memorys = new Map<number, IUpasmData>();
	public get regs() { return this._regs; }
	public readonly reg32Count;
	public readonly reg64Count;
	public readonly reg128Count;
	public readonly reg256Count;

	constructor(client:UpasmClient, regCount:number[])
	{
		this.client = client;
		this.reg32Count = regCount[0];
		this.reg64Count = regCount[1];
		this.reg128Count = regCount[2];
		this.reg256Count = regCount[3];
		let i=0, count = regCount[0];
		for (; i<count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0]});
		}
		count += regCount[1];
		for (; i<count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0, 0, 0, 0, 0]});
		}
		count += regCount[2];
		for (; i<count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]});
		}
		count += regCount[3];
		for (; i<count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]});
		}
		count += regCount[4];
		for (; i<count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0]});
		}
	}

	public updateRead()
	{
		let readRes = this.client.readRegisters();
		if (readRes.ok) {
			this.updateRegisters(readRes.bytes);
		}
		else {
			throw readRes.reason;
		}
		for (const m of this._memorys.values()) {
			let memRes = this.client.readMemory(m.idxOrAddr, m.bytes.length);
			if (memRes.ok) {
				m.bytes = memRes.bytes;
			}
			else {
				throw memRes.reason;
			}
		}
	}

	private updateRegisters(bytes:number[])
	{
		let idx = 0;
		for (const reg of this._regs) {
			for(let i=0;i<reg.bytes.length; i++) {
				reg.bytes[i] = bytes[idx];
				idx++;
			}
		}
	}

	public watchMemory(addr:number, length:number) : IUpasmData
	{
		let mem = this._memorys.get(addr);
		if (mem == undefined || mem.bytes.length < length) {
			let memRes = this.client.readMemory(addr, length);
			if (memRes.ok) {
				mem = {idxOrAddr:addr, bytes:memRes.bytes};
				this._memorys.set(addr, mem);
			}
			else {
				throw memRes.reason;
			}
		}

		if (mem != undefined && mem.bytes.length > length) {
			mem = {idxOrAddr:addr, bytes:mem.bytes.slice(0, length)};
		}
		return mem;
	}
}