/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import * as modes from 'vs/editor/common/modes';
import { Emitter, Event } from 'vs/base/common/event';
import { IMainContext, MainContext, MainThreadAuthenticationShape, ExtHostAuthenticationShape } from 'vs/workbench/api/common/extHost.protocol';
import { Disposable } from 'vs/workbench/api/common/extHostTypes';
import { IExtensionDescription, ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';

export class ExtHostAuthentication implements ExtHostAuthenticationShape {
	private _proxy: MainThreadAuthenticationShape;
	private _authenticationProviders: Map<string, vscode.AuthenticationProvider> = new Map<string, vscode.AuthenticationProvider>();

	private _onDidChangeAuthenticationProviders = new Emitter<vscode.AuthenticationProvidersChangeEvent>();
	readonly onDidChangeAuthenticationProviders: Event<vscode.AuthenticationProvidersChangeEvent> = this._onDidChangeAuthenticationProviders.event;

	private _onDidChangeSessions = new Emitter<{ [providerId: string]: vscode.AuthenticationSessionsChangeEvent }>();
	readonly onDidChangeSessions: Event<{ [providerId: string]: vscode.AuthenticationSessionsChangeEvent }> = this._onDidChangeSessions.event;

	constructor(mainContext: IMainContext) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadAuthentication);
	}

	getProviderIds(): Promise<ReadonlyArray<string>> {
		return this._proxy.$getProviderIds();
	}

	get providerIds(): string[] {
		const ids: string[] = [];
		this._authenticationProviders.forEach(provider => {
			ids.push(provider.id);
		});

		return ids;
	}

	private async resolveSessions(providerId: string): Promise<ReadonlyArray<modes.AuthenticationSession>> {
		const provider = this._authenticationProviders.get(providerId);

		let sessions;
		if (!provider) {
			sessions = await this._proxy.$getSessions(providerId);
		} else {
			sessions = await provider.getSessions();
		}

		return sessions;
	}

	async hasSessions(providerId: string, scopes: string[]): Promise<boolean> {
		const orderedScopes = scopes.sort().join(' ');
		const sessions = await this.resolveSessions(providerId);
		return !!(sessions.filter(session => session.scopes.sort().join(' ') === orderedScopes).length);
	}

	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopes: string[], options: vscode.AuthenticationGetSessionOptions & { createIfNone: true }): Promise<vscode.AuthenticationSession>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopes: string[], options: vscode.AuthenticationGetSessionOptions): Promise<vscode.AuthenticationSession | undefined> {
		const provider = this._authenticationProviders.get(providerId);
		const extensionName = requestingExtension.displayName || requestingExtension.name;
		const extensionId = ExtensionIdentifier.toKey(requestingExtension.identifier);

		if (!provider) {
			return this._proxy.$getSession(providerId, scopes, extensionId, extensionName, options);
		}

		const orderedScopes = scopes.sort().join(' ');
		const sessions = (await provider.getSessions()).filter(session => session.scopes.sort().join(' ') === orderedScopes);

		if (sessions.length) {
			if (!provider.supportsMultipleAccounts) {
				const session = sessions[0];
				const allowed = await this._proxy.$getSessionsPrompt(providerId, session.account.displayName, provider.displayName, extensionId, extensionName);
				if (allowed) {
					return session;
				} else {
					throw new Error('User did not consent to login.');
				}
			}

			// On renderer side, confirm consent, ask user to choose between accounts if multiple sessions are valid
			const selected = await this._proxy.$selectSession(providerId, provider.displayName, extensionId, extensionName, sessions, scopes, !!options.clearSessionPreference);
			return sessions.find(session => session.id === selected.id);
		} else {
			if (options.createIfNone) {
				const isAllowed = await this._proxy.$loginPrompt(provider.displayName, extensionName);
				if (!isAllowed) {
					throw new Error('User did not consent to login.');
				}

				const session = await provider.login(scopes);
				await this._proxy.$setTrustedExtension(providerId, session.account.displayName, extensionId, extensionName);
				return session;
			} else {
				await this._proxy.$requestNewSession(providerId, scopes, extensionId, extensionName);
				return undefined;
			}
		}
	}

	async logout(providerId: string, sessionId: string): Promise<void> {
		const provider = this._authenticationProviders.get(providerId);
		if (!provider) {
			return this._proxy.$logout(providerId, sessionId);
		}

		return provider.logout(sessionId);
	}

	registerAuthenticationProvider(provider: vscode.AuthenticationProvider): vscode.Disposable {
		if (this._authenticationProviders.get(provider.id)) {
			throw new Error(`An authentication provider with id '${provider.id}' is already registered.`);
		}

		this._authenticationProviders.set(provider.id, provider);

		const listener = provider.onDidChangeSessions(e => {
			this._proxy.$sendDidChangeSessions(provider.id, e);
		});

		this._proxy.$registerAuthenticationProvider(provider.id, provider.displayName, provider.supportsMultipleAccounts);

		return new Disposable(() => {
			listener.dispose();
			this._authenticationProviders.delete(provider.id);
			this._proxy.$unregisterAuthenticationProvider(provider.id);
		});
	}

	$login(providerId: string, scopes: string[]): Promise<modes.AuthenticationSession> {
		const authProvider = this._authenticationProviders.get(providerId);
		if (authProvider) {
			return Promise.resolve(authProvider.login(scopes));
		}

		throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
	}

	$logout(providerId: string, sessionId: string): Promise<void> {
		const authProvider = this._authenticationProviders.get(providerId);
		if (authProvider) {
			return Promise.resolve(authProvider.logout(sessionId));
		}

		throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
	}

	$getSessions(providerId: string): Promise<ReadonlyArray<modes.AuthenticationSession>> {
		const authProvider = this._authenticationProviders.get(providerId);
		if (authProvider) {
			return Promise.resolve(authProvider.getSessions());
		}

		throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
	}

	async $getSessionAccessToken(providerId: string, sessionId: string): Promise<string> {
		const authProvider = this._authenticationProviders.get(providerId);
		if (authProvider) {
			const sessions = await authProvider.getSessions();
			const session = sessions.find(session => session.id === sessionId);
			if (session) {
				return session.accessToken;
			}

			throw new Error(`Unable to find session with id: ${sessionId}`);
		}

		throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
	}

	$onDidChangeAuthenticationSessions(providerId: string, event: modes.AuthenticationSessionsChangeEvent) {
		this._onDidChangeSessions.fire({ [providerId]: event });
		return Promise.resolve();
	}

	$onDidChangeAuthenticationProviders(added: string[], removed: string[]) {
		this._onDidChangeAuthenticationProviders.fire({ added, removed });
		return Promise.resolve();
	}
}
