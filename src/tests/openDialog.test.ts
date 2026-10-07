import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { BankingInformation } from '../bankingInformation.js';
import type { BPD } from '../bpd.js';
import { FinTSConfig } from '../config.js';
import { Dialog } from '../dialog.js';
import {
	type ClientResponse,
	CustomerOrderInteraction,
} from '../interactions/customerInteraction.js';
import { EndDialogInteraction } from '../interactions/endDialogInteraction.js';
import { type CustomerMessage, Message } from '../message.js';
import { HKSAL } from '../segments/HKSAL.js';
import { HKTAN, type HKTANSegment } from '../segments/HKTAN.js';
import { registerSegments } from '../segments/registry.js';

vi.mock('../httpClient.js', () => ({
	HttpClient: class MockHttpClient {
		sendMessage = vi.fn();
	},
}));

registerSegments();

const answer = (over: Partial<ClientResponse> = {}) =>
	({
		dialogId: 'DIALOG',
		success: true,
		requiresTan: false,
		bankAnswers: [{ code: 20, text: 'ok' }],
		...over,
	}) as ClientResponse;

class Order extends CustomerOrderInteraction {
	constructor(public result: ClientResponse[]) {
		super(HKSAL.Id, 'HISAL');
	}
	createSegments() {
		return [];
	}
	handleResponse() {}
	handleClientResponse = vi.fn(() => this.result.shift() ?? answer());
}

function sentSegments(mock: MockInstance): string[][] {
	return mock.mock.calls.map(([message]) =>
		(message as CustomerMessage).segments.map((segment) => segment.header.segId),
	);
}

describe('a dialog that is kept open', () => {
	let dialog: Dialog;
	let send: MockInstance;

	beforeEach(() => {
		const bankingInformation: BankingInformation = {
			systemId: 'SYSTEM',
			bankMessages: [],
			bpd: {
				version: 1,
				bankId: '12345678',
				bankName: 'Testbank',
				countryCode: 280,
				url: 'https://bank.example/fints',
				allowedTransactions: [{ transId: HKSAL.Id, tanRequired: false, versions: [5] }],
				supportedTanMethods: [
					{ id: 920, name: 'pushTAN', version: 7, isDecoupled: true, tanMediaRequirement: 0 },
				],
				availableTanMethodIds: [920],
				supportedLanguages: [],
				maxTransactionsPerMessage: 1,
			} as unknown as BPD,
		};

		const config = FinTSConfig.fromBankingInformation(
			'PRODUCT',
			'1.0',
			bankingInformation,
			'user',
			'pin',
			920,
		);

		dialog = new Dialog(config, false, true);
		vi.spyOn(dialog.interactions[0], 'handleClientResponse').mockReturnValue(answer());
		send = vi.mocked(dialog.httpClient.sendMessage);
		send.mockResolvedValue(new Message([]));
	});

	it('stops after the login and does not end itself', async () => {
		await dialog.start();

		expect(dialog.interactions.some((i) => i instanceof EndDialogInteraction)).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
		expect(dialog.isOpen).toBe(true);
		expect(dialog.hasEnded).toBe(false);
	});

	it('runs one order after another in the same dialog, counting messages on', async () => {
		await dialog.start();
		await dialog.run(new Order([]));
		await dialog.run(new Order([]));

		expect(send).toHaveBeenCalledTimes(3);
		expect(dialog.lastMessageNumber).toBe(3);
		expect(dialog.dialogId).toBe('DIALOG');
		expect(dialog.isOpen).toBe(true);
	});

	it('waits on an order that needs approval, and takes no other meanwhile', async () => {
		await dialog.start();
		const order = new Order([
			answer({ requiresTan: true, tanReference: 'REF' }),
			answer({ requiresTan: true, tanReference: 'REF' }),
			answer(),
		]);

		await dialog.run(order);
		expect(dialog.isWaiting).toBe(true);
		await expect(dialog.run(new Order([]))).rejects.toThrow('still waits');

		await dialog.continue('REF');
		expect(dialog.isWaiting).toBe(true);
		await dialog.continue('REF');
		expect(dialog.isWaiting).toBe(false);

		// The order once, then nothing but status requests: an approval never resends it.
		expect(order.handleClientResponse).toHaveBeenCalledTimes(3);
		const [, , firstPoll, secondPoll] = send.mock.calls.map(([m]) => m as CustomerMessage);
		for (const poll of [firstPoll, secondPoll]) {
			const hktan = poll.segments.find((s) => s.header.segId === HKTAN.Id) as HKTANSegment;
			expect(hktan.tanProcess).toBe('S');
			expect(hktan.orderRef).toBe('REF');
		}
		expect(dialog.isOpen).toBe(true);
	});

	it('does not send a refused order again with the next one', async () => {
		await dialog.start();
		const refused = new Order([
			answer({ success: false, bankAnswers: [{ code: 9230, text: 'no' }] }),
		]);
		const next = new Order([]);

		await dialog.run(refused);
		await dialog.run(next);

		expect(refused.handleClientResponse).toHaveBeenCalledTimes(1);
		expect(next.handleClientResponse).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it('refuses an order before the login', async () => {
		await expect(dialog.run(new Order([]))).rejects.toThrow('open dialog');
	});

	it('ends on request, giving up an order that still waits', async () => {
		await dialog.start();
		await dialog.run(new Order([answer({ requiresTan: true, tanReference: 'REF' })]));
		await dialog.end();

		expect(sentSegments(send).at(-1)).toContain('HKEND');
		expect(dialog.hasEnded).toBe(true);
		expect(dialog.isOpen).toBe(false);
		await expect(dialog.run(new Order([]))).rejects.toThrow('open dialog');
	});

	it('has nothing to end at the bank when the login never opened it', async () => {
		await dialog.end();

		expect(send).not.toHaveBeenCalled();
		expect(dialog.hasEnded).toBe(true);
	});
});
