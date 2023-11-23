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

	constructor(client:UpasmClient, reg32Count:number, reg64Count:number, reg128Count:number, reg256Count:number)
	{
		this.client = client;
		let i=0;
		for (; i<reg32Count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0]});
		}
		for (; i<reg32Count + reg64Count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0, 0, 0, 0, 0]});
		}
		for (; i<reg32Count + reg64Count + reg128Count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]});
		}
		for (; i<reg32Count + reg64Count + reg128Count + reg256Count; i++) {
			this._regs.push({idxOrAddr:i, bytes:[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]});
		}
		this.reg32Count = reg32Count;
		this.reg64Count = reg64Count;
		this.reg128Count = reg128Count;
		this.reg256Count = reg256Count;
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