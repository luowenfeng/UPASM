import * as vscode from 'vscode';
import { UpasmExt } from './UpasmExt';
import { UpasmClient } from './UpasmClient';

export const tokenTypeText = [
	'notInContext',
	'comment',
	'directive',
	'type',
	'string',
	'number',
	'macro',
	'label',
	'variable',
	'instruction',
	'register',
	'keyword',
	'operator',
	'bracket',
	'invalid'
];

export async function activate(context: vscode.ExtensionContext) 
{
	// let serverPath = path.join(context.extensionPath, '../Tools/Debug/UpasmServer.exe');
	// let portFile = path.join(context.extensionPath, '../Tools/Debug/upasm-server-port.txt');
	//let portFile = path.join(context.extensionPath, 'tools/upasm-server-port.txt');
	console.log(process.pid);
	vscode.window.showInformationMessage("ProcessID:" + process.pid);	
	let client = new UpasmClient(context.extensionPath);
	let ext = new UpasmExt(context, client);
	
	context.subscriptions.push(vscode.commands.registerCommand('upasm.build', ext.onRebuild, ext));
	context.subscriptions.push(vscode.commands.registerCommand('upasm.reload', ext.openWorkspace, ext));
	context.subscriptions.push(vscode.commands.registerCommand('upasm.rename', ext.onRename, ext));
	context.subscriptions.push(vscode.commands.registerTextEditorCommand('upasm.update-registers', ext.onUpdateRegister, ext));
	context.subscriptions.push(vscode.commands.registerTextEditorCommand('upasm.count-instructions', ext.onCountInstructions, ext));
	context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider({ language: 'upasm' }, ext, new vscode.SemanticTokensLegend(tokenTypeText)));
	context.subscriptions.push(vscode.languages.registerHoverProvider('upasm', ext));
	context.subscriptions.push(vscode.languages.registerDefinitionProvider('upasm', ext));
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('upasm', ext));
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('upasm', ext));
	context.subscriptions.push(vscode.commands.registerCommand('upasm.gensource', uri => {
		const filePath = uri.fsPath;
		ext.gensource(filePath);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('upasm.project.setcurrent', uri => {		
		const filePath = uri.fsPath;
		ext.resetProj(filePath);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('upasm.project.addNew', uri => {
		const filePath = uri.fsPath;
		ext.addNewProj(filePath);
	}));


//	let renameButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
//	renameButton.command = 'upasm.rename';
//	renameButton.text = `$(settings-sync-view-icon) Rename`;
//	renameButton.tooltip = '*.inc=>*.upinc, *.asm=>*.upasm, *.fct=>*.upasm, *.conf=>*.upconf';
//	renameButton.show();

	context.subscriptions.push(client);
}