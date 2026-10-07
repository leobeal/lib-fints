import type { AccountRef } from '../bankAccount.js';
import type { FinTSConfig } from '../config.js';
import { BalanceInteraction } from './balanceInteraction.js';
import type { CustomerInteraction, InteractionSnapshot } from './customerInteraction.js';
import { DirectDebitInteraction } from './directDebitInteraction.js';
import { InitDialogInteraction } from './initDialogInteraction.js';
import { ScheduledDirectDebitsInteraction } from './scheduledDirectDebitsInteraction.js';
import { StatementInteractionCAMT } from './statementInteractionCAMT.js';
import { StatementInteractionMT940 } from './statementInteractionMT940.js';

const date = (value: unknown) => (typeof value === 'string' ? new Date(value) : undefined);

/**
 * Builds an interaction from its snapshot. Keyed by a name each interaction gives
 * itself rather than by its class name, which a minifier rewrites.
 */
export function restoreInteraction(
	config: FinTSConfig,
	{ kind, state }: InteractionSnapshot,
): CustomerInteraction {
	const account = state.account as AccountRef;

	switch (kind) {
		case 'init':
			return new InitDialogInteraction(config, state.syncSystemId === true);
		case 'directDebit':
			return new DirectDebitInteraction(account, state.painXml as string, state.orderId as string);
		case 'statementsCamt':
			return new StatementInteractionCAMT(account, date(state.from), date(state.to));
		case 'statementsMt940':
			return new StatementInteractionMT940(account, date(state.from), date(state.to));
		case 'scheduledDirectDebits':
			return new ScheduledDirectDebitsInteraction(account, date(state.from), date(state.to));
		case 'balance':
			return new BalanceInteraction(account);
		default:
			throw Error(`an interaction of kind '${kind}' cannot be taken up again`);
	}
}
