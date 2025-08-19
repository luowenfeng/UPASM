import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { IAsmInfo, IBuildInfo, IConfigInfo, IUpasmDebuggerListener, UpasmClient, getNameRef } from './UpasmClient';
import { tokenTypeText } from './extension';
import { EventEmitter } from 'stream';
import { UpasmDebugSession } from './UpasmDebugSession';
import { UpasmWatcher } from './UpasmWatcher';
import { UpasmReferenceManager } from './UpasmReference';

export interface RegMap {
	idx:number;
	mapTo:number;
	offsetBit:number;
	bitLen:number;
}

function findFiles(rootPath:string, suffix:RegExp) : string[]
{
	let res = [];
	let files = fs.readdirSync(rootPath);

	for (const file of files) {
		let filename = path.join(rootPath, file);
		let states = fs.statSync(filename);
		if (states.isDirectory()) {
			let sub = findFiles(filename, suffix);
			for (const i of sub) {
				res.push(i);
			}
		}
		else {
			if (file.match(suffix)) {
				res.push(filename.toLocaleLowerCase());
			}
		}
	}
	return res;
}

function getDecorationColor(type:string)
{
	switch(type) {
	case 'empty':
		return 'upasm.section.background';

	case 'section':
		return 'upasm.section.background';

	case 'error':
		return 'upasm.error.background';
	
	case 'instruction':
		return 'upasm.code.background';

	case 'data':
		return 'upasm.data.background';

	case 'condition':
		return 'upasm.condition.background';

	case 'condition_rj':
		return 'upasm.condition.lcs.background';
	}
	return 'upasm.errorBackground';
}

function updateDecorations(activeEditor:vscode.TextEditor|null, files:Map<string, IAsmInfo>) {
	if (activeEditor == null)
		return;

	let showdeco = vscode.workspace.getConfiguration().get<boolean>('upasm.config.showdeco');

	let filename = activeEditor.document.fileName;
	let fileInfo = files.get(filename);
	if (!fileInfo) {
		return;
	}
	let decorations:vscode.DecorationOptions[] = [];
	try {
		for (const c of fileInfo.lines.values()) {
			if (c.type == 'empty' && c.decoText == '') continue;

			if (showdeco || c.type == 'error') {
				decorations.push({
					range: new vscode.Range(c.lineNum, 0, c.lineNum, c.textLen),
					renderOptions: {
						after:{
							contentText: c.decoText,
							backgroundColor: { id: getDecorationColor(c.type) },
						}
					}
				});
			}
		}
	} catch (error) {
		console.log(error);
	}
	
	activeEditor.setDecorations(UpasmExt.decorationType, decorations);
}

function getErrorsFromBuildInfo(buildInfo:IBuildInfo)
{
	let errs = [];
	for (const err of buildInfo.errors) {
		errs.push(err);
	}
	return errs;
}

export class UpasmRuntimeEvent extends EventEmitter {
	constructor() {
		super();
		this.setMaxListeners(64);
	}

	sendEvent(event: string, ... args: any[]): void {
		setImmediate(() => {
			this.emit(event, ...args);
		});
	}
}

export class UpasmExt implements vscode.DocumentSemanticTokensProvider, 
								 vscode.HoverProvider, 
								 vscode.DefinitionProvider, 
								 vscode.DebugConfigurationProvider,
								 vscode.DebugAdapterDescriptorFactory,
								 IUpasmDebuggerListener {
	static decorationType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        after: {
            margin: '0 0 0 3em'
        }
	});
	//private context: vscode.ExtensionContext;
	private timeout: NodeJS.Timer | undefined = undefined;
	private activeEditor;
	private outputChannel;
	private currentPath;
	private projfile = "";
	private client:UpasmClient;
	private buildInfo?:IBuildInfo;
	private configInfo?:IConfigInfo;
	private dbgEvent = new UpasmRuntimeEvent();
	private dbgSession?:UpasmDebugSession;
	private watcher?:UpasmWatcher;
	private refMgr?:UpasmReferenceManager;
	private buildButton;

	//#region IUpasmDebuggerListener
	onDebugEror(err:string):void
	{
		this.dbgEvent.sendEvent('error', err);
		this.outputChannel.appendLine(err + '\n');
		this.dbgSession = undefined;
	}

	onDebugEnd(msg:string):void
	{
		this.dbgEvent.sendEvent('end');
		this.dbgSession = undefined;
		//this.outputChannel.clear()
		this.outputChannel.appendLine(msg + '\n');
		this.outputChannel.show();
		//vscode.commands.executeCommand('switch.readonly', false);
	}

	onDebugMessage(msg:string):void
	{
		this.dbgEvent.sendEvent('output', msg);
	}

	onDebugPause(filename:string, lineNum:number):void
	{
		try {
			//this.watcher?.updateRead();
			this.refMgr?.updateWatcher();
			this.dbgSession?.setCurrentPosition(filename, lineNum);
			this.dbgEvent.sendEvent('stopOnStep');	
		} catch (error) {
			this.dbgEvent.sendEvent('error', error);
		}
	}
	//#endregion


	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	 resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.DebugConfiguration {
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'upasm') {
				config.type = 'upasm';
				config.name = 'Launch';
				config.request = 'launch';
				config.stopOnEntry = true;
			}
		}

		return config;
	}

	createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		return new Promise((resolve, reject) => {
			vscode.workspace.saveAll().then(() => {	
				const res = this.client.rebuild();
				if (res.reason != undefined  && res.reason != '') {
					reject(res.reason);
				}
				if (this.checkBuildResult(res)) {
					const dbg = this.client.startDebug();
					if (dbg.ok && dbg.regCount && dbg.regCount.length >= 4) {						
						
						this.watcher = new UpasmWatcher(this.client, dbg.regCount);
						try {
							this.outputChannel.clear();
							this.watcher.updateRead();
							this.refMgr = new UpasmReferenceManager(this.watcher, this.configInfo!, this.buildInfo!);
							this.dbgSession = new UpasmDebugSession(dbg.useSimulator, this.refMgr, dbg.filename, dbg.lineNum, this.dbgEvent, this.client);
							this.dbgSession.rootPath = this.currentPath;
							resolve(new vscode.DebugAdapterInlineImplementation(this.dbgSession));
							this.dbgEvent.sendEvent('stopOnEntry');
							//vscode.commands.executeCommand('switch.readonly', true);
						} catch (error) {
							reject(error);
						}
					}
					else {
						reject('UPASM: Start debugger failed with reason ' + dbg.reason);
					}
				}
				else {
					reject('UPASM: Build project failed with reason ' + res.reason);
				}
			});
		});
	}

	provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken):vscode.SemanticTokens
	{
		const vsbuilder = new vscode.SemanticTokensBuilder();
		if (document.fileName.match(/.upinc$|.upasm$|.upconf$/)) {
			const res = this.client.getFile(document.fileName);
			if (res.fileInfo) {
				this.buildInfo?.files.set(document.fileName, res.fileInfo);
				this.buildInfo?.lowerFiles.set(document.fileName.toLowerCase(), res.fileInfo);
				for (const c of res.fileInfo.lines.values()) {
					if (c.type == 'notInContext') {
						vsbuilder.push(c.lineNum, 0, c.textLen, 0);
					}
					else {
						for (const t of c.tokens) {
							vsbuilder.push(c.lineNum, t.start, t.length, tokenTypeText.indexOf(t.type));
						}
					}
				}
				this.triggerUpdateDecorations();
			}
		}
		return vsbuilder.build();
	}

	private findLine(filename:string, lineNum:number) {
		let asmInfo = this.buildInfo?.files.get(filename);
		if (asmInfo) {
			return asmInfo.lines.get(lineNum);
		}
		return undefined;
	}

	provideHover(document: vscode.TextDocument, position:vscode.Position, token:vscode.CancellationToken) : vscode.ProviderResult<vscode.Hover>
	{
		let line = this.findLine(document.fileName, position.line);
		if (line == undefined) 	return {contents:[]};
		for (const tk of line.tokens) {
			if (tk.start <= position.character && tk.start + tk.length >= position.character) {
				if (tk.refText) {
					if (tk.refLineNum! >= 0) {
						return {
							contents: [tk.refText!, tk.refFilename! + ' + ' + (tk.refLineNum! + 1).toString()]
						};
					}
					else {
						return {
							contents: [tk.refText!]
						};
					}
				}
				else {
					if (this.buildInfo) {
						let text = document.lineAt(position.line).text.substring(tk.start, tk.start+tk.length);
						let nameRef = getNameRef(this.buildInfo!, document.fileName, position.line, text);
						if (nameRef) {
							if (nameRef.refLine >= 0) {
								return {contents:[nameRef.content, nameRef.refFile + '+' + (nameRef.refLine+1).toString()]};
							}
							else {
								return {contents:[nameRef.content]};
							}
						}
					}
				}
				break;
			}
		}
		
	}

	provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> 
	{
		let line = this.findLine(document.fileName, position.line);
		if (line == undefined) 	return undefined;

		for (const tk of line.tokens) {
			if (tk.start <= position.character && tk.start + tk.length >= position.character) {
				if (tk.refText) {
					return new vscode.Location(vscode.Uri.file(tk.refFilename!), new vscode.Position(tk.refLineNum!, 0));
				}
				else {
					if (this.buildInfo) {
						let text = document.lineAt(position.line).text.substring(tk.start, tk.start+tk.length);
						let nameRef = getNameRef(this.buildInfo!, document.fileName, position.line, text);
						if (nameRef) {
							if (nameRef.refLine >= 0) {
								return new vscode.Location(vscode.Uri.file(nameRef.refFile!), new vscode.Position(nameRef.refLine!, 0));
							}
						}
					}					
				}
				break;
			}
		}
		return undefined;
	}

	private checkBuildResult(buildRes:{buildInfo?:IBuildInfo, reason:string})
	{
		let errors = [];
		if (buildRes.reason != undefined && buildRes.reason != '') {
			errors.push(buildRes.reason);
		}
		if (buildRes.buildInfo) {
			this.buildInfo = buildRes.buildInfo;
			errors = errors.concat(getErrorsFromBuildInfo(buildRes.buildInfo));
		}
		if (errors.length) {
			this.outputChannel.clear();
			for (const error of errors) {
				this.outputChannel.appendLine(error);
			}
			this.outputChannel.show();
		}
		return true;
	}

	public openWorkspace()
	{
		this.projfile = vscode.workspace.getConfiguration().get<string>('upasm.project.filename')!;
		let projname = this.projfile;
		if (projname == '') {
			projname = 'default.upproj';
		}
		this.buildButton.text = '$(file-binary) Build ' + projname;

		let open = this.client.openWorkspace(this.currentPath, this.projfile);
		if (open.buildInfo?.cfg) {
			this.configInfo = open.buildInfo?.cfg;
		}
		this.checkBuildResult(open);		
	}

	constructor(context: vscode.ExtensionContext, client:UpasmClient)
	{
		this.client = client;
		client.debugListener = this;
		this.currentPath = vscode.workspace.workspaceFolders![0].uri.fsPath;
		this.outputChannel = vscode.window.createOutputChannel('UPASM');

		this.buildButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
		this.buildButton.command = 'upasm.build';
		this.buildButton.tooltip = 'UPASM: Build';
		this.buildButton.show();

		this.openWorkspace();

	
		
		this.activeEditor = vscode.window.activeTextEditor;		
		vscode.window.onDidChangeActiveTextEditor(editor => {
			this.activeEditor = editor;
			if (editor) {
				let ff = this.buildInfo?.files.get(editor.document.fileName);
				if (ff) {
					this.triggerUpdateDecorations();
				}
				else {
					let res = this.client.getFile(editor.document.fileName);
					if (res.fileInfo) {
						this.triggerUpdateDecorations();
					}
				}
			}
		}, null, context.subscriptions);

		vscode.workspace.onDidChangeConfiguration(event=> {
			if (event.affectsConfiguration('upasm.project.filename')) {
				let projfile = vscode.workspace.getConfiguration().get<string>('upasm.project.filename')!;
				if (projfile != this.projfile) {
					this.openWorkspace();
				}
			}
		});

		vscode.workspace.onDidChangeWorkspaceFolders(event => {
			if (event.added.length) {
				this.currentPath = event.added[0].uri.fsPath;
				this.openWorkspace();
			}
		}, null, context.subscriptions);

		vscode.workspace.onDidCloseTextDocument(event => {			
			if (event.fileName.match(/.upinc$|.upasm$|.upconf$/) && event.isDirty) {
				const res = this.client.reloadFile(event.fileName);
				if (!res.ok) {
					this.outputChannel.appendLine(res.reason);
				}
			}
		}, null, context.subscriptions);

		vscode.workspace.onDidSaveTextDocument(event => {
			if (event.fileName.match(/.upinc$|.upasm$|.upconf$|.upproj$/)) {
				const res = this.client.reloadFile(event.fileName);
				if (!res.ok)  {
					this.outputChannel.appendLine(res.reason);
				}
			}
			
		}, null, context.subscriptions);

		vscode.workspace.onDidChangeTextDocument(event => {
			if (event.contentChanges.length > 0 && event.document.fileName.match(/.upinc$|.upasm$|.upconf$|.upproj$/)) {
				if (this.dbgSession == undefined) {
					const res = this.client.updateFile(event.document.fileName, event.document.getText());
					if (!res.ok) {
						this.outputChannel.appendLine(res.reason);
					}
					else {
						if (this.buildInfo!.files.has(event.document.fileName)) {
							this.buildInfo!.files.set(event.document.fileName, res.fileInfo!);
						}						
					}
				}
				else {
					vscode.window.showWarningMessage("请勿在调试状态下修改代码!");
				}
			}
		}, null, context.subscriptions);

		vscode.workspace.onDidCreateFiles(event => {
			//const res = this.client.rebuild();
			//this.checkBuildResult(res);
		});
	
		vscode.workspace.onDidDeleteFiles(event => {
			//const res = this.client.rebuild();
			//this.checkBuildResult(res);
		});

		vscode.workspace.onDidRenameFiles(event => {
			//const res = this.client.rebuild();
			//this.checkBuildResult(res);
		});
		this.triggerUpdateDecorations();
	}

	private triggerUpdateDecorations() {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
		this.timeout = setTimeout(updateDecorations, 500, this.activeEditor, this.buildInfo?.files);
	}

	public onCountInstructions(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit)
	{
		let start = textEditor.selection.start.line;
		let end = textEditor.selection.end.line;
		let content = this.client.countInstructions(textEditor.document.fileName, start, end);

		this.outputChannel.clear();
		this.outputChannel.appendLine("Total instructions:" + content.total);
		for (const c of content.content) {
			this.outputChannel.appendLine("\t" + c.name + ":" + c.count);
		}
		this.outputChannel.show();
	}

	public onUpdateRegister(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit)
	{
		let range = new vscode.Range(textEditor.selection.start, textEditor.selection.end);
		let text = textEditor.document.getText(range);
		let reg32Count = this.configInfo!.reg32Count;

		if (text.length == 0 || reg32Count == 0) {
			return;
		}

		let matchArray = text.match(/\br[0-9]+/g); // g表示全局匹配
		if (!matchArray) {
			vscode.window.showInformationMessage('选中的文本中没有包含任何寄存器');
			return;
		}
		
		let minidx = reg32Count;
		for (const m of matchArray) {
			let n = parseInt(m.substring(1));
			if (n < minidx) {
				minidx = n;
			}
		}
		
		let minValue = 'r' + minidx;
		vscode.window.showInputBox({prompt:'起始寄存器', value:minValue, valueSelection:[1,minValue.length]}).then(input => {
			if (input == undefined) return;
			if (input[0] != 'r') {
				vscode.window.showErrorMessage('输入的起始寄存器必须是      r+数字      的形式');
				return;
			}
			let idx = parseInt(input.substring(1));
			if (isNaN(idx) || idx < 0 || idx >= reg32Count!) {
				vscode.window.showErrorMessage('输入的起始寄存器必须是      r+数字      的形式(最大为r' + (reg32Count! - 1) + ')');
				return;
			}
			if (input == minValue) return;

			let newText = '';
			let reg = new RegExp(/\br[0-9]+/);
			while(true) {
				let m = reg.exec(text);
				if (m == undefined) break;

				let n = idx - minidx + parseInt(m[0].substring(1));
				if (n >= reg32Count!) {
					vscode.window.showErrorMessage('寄存器超出范围!(最大为r' + (reg32Count! - 1) + ')');
					return;	
				}

				newText += text.substring(0, m.index);
				newText += 'r' + n;

				text = text.substring(m.index + m[0].length);
			}
			newText += text;
			//edit.replace(range, text);

			textEditor.edit((editBuilder) => {
				editBuilder.replace(range, newText);
			})
		});
	}

	public onRename()
	{
		let allNames = [];
		let names = findFiles(this.currentPath, /.inc$/);
		for (const name of names) {
			let newName = name.replace('.inc', '.upinc');
			fs.renameSync(name, newName);
			allNames.push(newName);
		}

		names = findFiles(this.currentPath, /.asm$/);
		for (const name of names) {
			let newName = name.replace('.asm', '.upasm');
			fs.renameSync(name, newName);
			allNames.push(newName);
		}

		names = findFiles(this.currentPath, /.conf$/);
		for (const name of names) {
			let newName = name.replace('.conf', '.upconf');
			fs.renameSync(name, newName);
			allNames.push(newName);
		}

		names = findFiles(this.currentPath, /.fct$/);
		for (const name of names) {
			let newName = name.replace('.fct', '.upasm');
			fs.renameSync(name, newName);
			allNames.push(newName);
		}

		allNames = findFiles(this.currentPath, /.upinc$|.upasm$|.upconf$/);

		let reg = new RegExp(/#include "[\S]*\.inc"/);
		for (const name of allNames) {
			let lines = fs.readFileSync(name, 'utf-8').split(/\r|\n|\r\n/);
			let update = false;
			for (const line of lines) {
				if (reg.test(line)) {
					update = true;
					break;
				}
			}

			if (update) {
				let text = '';
				for (const line of lines) {
					if (reg.test(line)) {
						text += line.replace('.inc', '.upinc') + '\n';
					}
					else {
						text += line + '\n';
					}
				}

				fs.writeFileSync(name, text);
			}
		}
	}

	public onRebuild()
	{
		vscode.workspace.saveAll().then(() => {
			let before = Date.now();
			const res = this.client.rebuild();
			let after = Date.now();			

			if (this.checkBuildResult(res)) {
				const outRes = this.client.output();
				let projfile = this.projfile;
				if (projfile == '') {
					projfile = "default.upproj";
				}
				if (outRes.ok) {
					this.outputChannel.appendLine('Build "' + projfile + '" succeed at ' + (new Date()).toLocaleString());
					this.outputChannel.appendLine('\tProgram size:' + res.buildInfo!.programSize + ' bytes');
					this.outputChannel.appendLine('\tData size:' + res.buildInfo!.dataSize + ' bytes');
					this.outputChannel.appendLine('\tReserve size:' + res.buildInfo!.reserveSize + ' bytes');
					this.outputChannel.appendLine('\tBinary file size(Program + Data):' + (res.buildInfo!.programSize + res.buildInfo!.dataSize) + ' bytes');
					this.outputChannel.appendLine('\tTotal size(Program + Data + Reserve):' + (res.buildInfo!.programSize + res.buildInfo!.dataSize + res.buildInfo!.reserveSize) + ' bytes');
					this.outputChannel.appendLine('Output files:');
					for (const name of outRes.files) {
						this.outputChannel.appendLine('\t'+name);
					}
					//for(const filename of outRes.files) {
					//	if (filename.endsWith('.bin')) {
					//		this.outputChannel.appendLine('binary file size:' + fs.fstatSync(filename).size + ' bytes');
					//		break;
					//	}
					//}
					this.outputChannel.show();
				}
				else {
					this.outputChannel.appendLine('Build "' + projfile + '" failed!\n' + outRes.reason);
					this.outputChannel.show();	
				}
				this.outputChannel.appendLine('Cost ' + (after - before) + ' ms');
			}
		});
	}

	public gensource(upconf: string)
	{
		if (upconf.endsWith('.upconf')) {
			let genRes = this.client.gensource(upconf);
			if (genRes.ok) {
				this.outputChannel.appendLine('Generate source successfully created:');
				this.outputChannel.appendLine(genRes.incname);
				this.outputChannel.appendLine(genRes.asmname);
				this.outputChannel.show();
			}
			else {
				this.outputChannel.clear();
				this.outputChannel.appendLine(genRes.reason);
				this.outputChannel.show();
			}
		}
	}

	public resetProj(projfile:string)
	{
		let relativePath = path.relative(this.currentPath, projfile);		
		let config = vscode.workspace.getConfiguration('upasm.project');
		if (relativePath == this.projfile) {
			this.openWorkspace();
		}
		else {
			config.update('filename', relativePath, false);
		}		
	}


	private static default_proj_content = '\
#BUILD-INFO\n\
TYPE=APP\n\
NAME=app\n\
CFG=u31\n\
ENTRY_NAME=entry\n\
\n\
#DEBUG-INFO\n\
DEBUG_TYPE=IIC\n\
SIMULATE_DATA=simdata\n\
\n\
#OUTPUT-INFO\n\
PATH=out\n\
BIN=true\n\
HEX=true\n\
MAP=false\n\
OBJS=false\n\
\n\
#FILES\n\
[ext]upinc\n\
[ext]upasm\n\
\n\
#EXCLUDE\n\
[dir]out\n\
\n\
#MACROS\n\
\n\
#GENERATION\n\
PREFIX=u31_sys\n\
'
	public addNewProj(p:string)
	{
		let dirname = p;
		let stat = fs.statSync(p);
		if (!stat.isDirectory()) {
			dirname = path.dirname(p);
		}
		
		const filePath = vscode.Uri.file(dirname + '/new.upproj');
		const wsedit = new vscode.WorkspaceEdit();
		wsedit.createFile(filePath, { ignoreIfExists: true });
		vscode.workspace.applyEdit(wsedit).then(value=> {
			if (value) {
				vscode.workspace.fs.writeFile(filePath, Buffer.from(UpasmExt.default_proj_content, 'ascii')).then(()=>{
					vscode.workspace.openTextDocument(filePath).then(doc => {
						vscode.window.showTextDocument(doc);
					});
				});
			}
			else {
				vscode.window.showErrorMessage('create file "' + filePath + '" failed!!!');
			}
		})
		
	}
}