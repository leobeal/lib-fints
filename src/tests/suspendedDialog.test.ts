import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { BankingInformation } from '../bankingInformation.js';
import type { BPD } from '../bpd.js';
import { FinTSConfig } from '../config.js';
import { Dialog, type DialogSnapshot } from '../dialog.js';
import { BalanceInteraction } from '../interactions/balanceInteraction.js';
import type { ClientResponse } from '../interactions/customerInteraction.js';
import { DirectDebitInteraction } from '../interactions/directDebitInteraction.js';
import { EndDialogInteraction } from '../interactions/endDialogInteraction.js';
import { PortfolioInteraction } from '../interactions/portfolioInteraction.js';
import { StatementInteractionCAMT } from '../interactions/statementInteractionCAMT.js';
import { type CustomerMessage, Message } from '../message.js';
import { HKTAN, type HKTANSegment } from '../segments/HKTAN.js';
import { registerSegments } from '../segments/registry.js';

vi.mock('../httpClient.js', () => ({
	HttpClient: class MockHttpClient {
		sendMessage = vi.fn();
	},
}));

registerSegments();

const PAIN =
	'<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02"><GrpHdr><CtrlSum>20.00</CtrlSum></GrpHdr><PmtTpInf><LclInstrm><Cd>CORE</Cd></LclInstrm></PmtTpInf><DrctDbtTxInf><Nm>Jürgen</Nm></DrctDbtTxInf><DrctDbtTxInf><Nm>Anna</Nm></DrctDbtTxInf></Document>';

const answer = (over: Partial<ClientResponse> = {}) =>
	({
		dialogId: 'DIALOG',
		success: true,
		requiresTan: false,
		bankAnswers: [],
		...over,
	}) as ClientResponse;

function config() {
	const transaction = (transId: string) => ({ transId, tanRequired: true, versions: [1] });
	const bankingInformation: BankingInformation = {
		systemId: 'SYSTEM',
		bankMessages: [],
		bpd: {
			version: 1,
			bankId: '12345678',
			bankName: 'Testbank',
			countryCode: 280,
			url: 'https://bank.example/fints',
			allowedTransactions: ['HKDME', 'HKCAZ', 'HKSAL', 'HKWPD'].map(transaction),
			supportedTanMethods: [
				{ id: 920, name: 'pushTAN', version: 7, isDecoupled: true, tanMediaRequirement: 0 },
			],
			availableTanMethodIds: [920],
			supportedLanguages: [],
			maxTransactionsPerMessage: 1,
		} as unknown as BPD,
		upd: {
			version: 1,
			usage: 0,
			bankAccounts: [{ accountNumber: '1000000001', iban: 'DE89370400440532013000' }],
		} as BankingInformation['upd'],
	};

	return FinTSConfig.fromBankingInformation(
		'PRODUCT',
		'1.0',
		bankingInformation,
		'user',
		'pin',
		920,
	);
}

/** A dialog that is logged in, with the given interaction sent and waiting for its approval. */
async function waitingOn(interaction: DirectDebitInteraction | StatementInteractionCAMT) {
	const dialog = new Dialog(config(), false, true);
	vi.spyOn(dialog.interactions[0], 'handleClientResponse').mockReturnValue(answer());
	vi.mocked(dialog.httpClient.sendMessage).mockResolvedValue(new Message([]));
	await dialog.start();

	vi.spyOn(interaction, 'handleClientResponse').mockReturnValue(
		answer({ requiresTan: true, tanReference: 'REF-1' }),
	);
	await dialog.run(interaction);

	return dialog;
}

/** What another process would have: the snapshot after a trip through storage. */
const stored = (dialog: Dialog) => JSON.parse(JSON.stringify(dialog.snapshot())) as DialogSnapshot;

describe('a dialog put away while it waits', () => {
	let send: MockInstance;
	let restored: Dialog;

	async function restore(snapshot: DialogSnapshot) {
		restored = Dialog.restore(config(), snapshot);
		send = vi.mocked(restored.httpClient.sendMessage);
		send.mockResolvedValue(new Message([]));
	}

	beforeEach(() => vi.clearAllMocks());

	it('holds what the bank waits on, and no PIN', async () => {
		const snapshot = stored(
			await waitingOn(new DirectDebitInteraction('1000000001', PAIN, 'HKDME')),
		);

		expect(snapshot).toEqual({
			dialogId: 'DIALOG',
			lastMessageNumber: 2,
			isInitialized: true,
			keepOpen: true,
			tanReference: 'REF-1',
			pending: [
				{ kind: 'directDebit', state: { account: '1000000001', painXml: PAIN, orderId: 'HKDME' } },
			],
		});
		expect(JSON.stringify(snapshot)).not.toContain('"pin"');
	});

	it('is taken up with a status request, never by sending the order again', async () => {
		await restore(stored(await waitingOn(new DirectDebitInteraction('1000000001', PAIN, 'HKDME'))));
		const order = restored.currentInteraction as DirectDebitInteraction;
		const handled = vi.spyOn(order, 'handleClientResponse').mockReturnValue(answer());

		expect(order).toBeInstanceOf(DirectDebitInteraction);
		expect(order.painXml).toBe(PAIN);
		expect(restored.isWaiting).toBe(true);

		const responses = await restored.continue('REF-1');

		expect(send).toHaveBeenCalledTimes(1);
		const message = send.mock.calls[0][0] as CustomerMessage;
		const segIds = message.segments.map((segment) => segment.header.segId);
		expect(segIds).not.toContain('HKDME');
		const hktan = message.segments.find((s) => s.header.segId === HKTAN.Id) as HKTANSegment;
		expect(hktan.tanProcess).toBe('S');
		expect(hktan.orderRef).toBe('REF-1');
		expect(hktan.segId).toBe('HKDME');

		// Same dialog, next message.
		expect(message.segments[0]).toMatchObject({ dialogId: 'DIALOG', msgNr: 3 });
		expect(handled).toHaveBeenCalledTimes(1);
		expect(responses.get('HKDME')?.success).toBe(true);
		expect(restored.isWaiting).toBe(false);
		expect(restored.isOpen).toBe(true);
		expect(restored.interactions.some((i) => i instanceof EndDialogInteraction)).toBe(false);
	});

	it('brings dates back as dates', async () => {
		const from = new Date('2026-09-01T00:00:00.000Z');
		const to = new Date('2026-10-01T00:00:00.000Z');
		await restore(stored(await waitingOn(new StatementInteractionCAMT('1000000001', from, to))));

		const statements = restored.currentInteraction as StatementInteractionCAMT;
		expect(statements).toBeInstanceOf(StatementInteractionCAMT);
		expect(statements.from).toEqual(from);
		expect(statements.to).toEqual(to);
	});

	it('can be put away open with nothing waiting, and takes an order afterwards', async () => {
		const dialog = new Dialog(config(), false, true);
		vi.spyOn(dialog.interactions[0], 'handleClientResponse').mockReturnValue(answer());
		vi.mocked(dialog.httpClient.sendMessage).mockResolvedValue(new Message([]));
		await dialog.start();

		await restore(stored(dialog));
		expect(restored.isOpen).toBe(true);
		expect(restored.isWaiting).toBe(false);

		const balance = new BalanceInteraction('1000000001');
		vi.spyOn(balance, 'handleClientResponse').mockReturnValue(answer());
		vi.spyOn(balance, 'getSegments').mockReturnValue([]);
		await restored.run(balance);

		expect(send).toHaveBeenCalledTimes(1);
		expect((send.mock.calls[0][0] as CustomerMessage).segments[0]).toMatchObject({ msgNr: 2 });
	});

	it('refuses to put away what it could not take up again', async () => {
		const portfolio = new PortfolioInteraction('1000000001');
		vi.spyOn(portfolio, 'getSegments').mockReturnValue([]);
		const dialog = await waitingOn(portfolio as unknown as StatementInteractionCAMT);

		expect(() => dialog.snapshot()).toThrow('HKWPD cannot be taken up again');
	});

	it('refuses a dialog that has ended', async () => {
		const dialog = await waitingOn(new DirectDebitInteraction('1000000001', PAIN, 'HKDME'));
		vi.mocked(dialog.httpClient.sendMessage).mockResolvedValue(new Message([]));
		await dialog.end();

		expect(() => dialog.snapshot()).toThrow('has ended');
	});
});
