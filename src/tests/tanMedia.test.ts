import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { BankingInformation } from '../bankingInformation.js';
import type { BPD } from '../bpd.js';
import { FinTSClient } from '../client.js';
import { FinTSConfig } from '../config.js';
import type { ClientResponse } from '../interactions/customerInteraction.js';
import { InitDialogInteraction } from '../interactions/initDialogInteraction.js';
import { TanMediaInteraction } from '../interactions/tanMediaInteraction.js';
import { type CustomerMessage, Message } from '../message.js';
import { HKTAB } from '../segments/HKTAB.js';
import { HKTAN, type HKTANSegment } from '../segments/HKTAN.js';
import { registerSegments } from '../segments/registry.js';

const send = vi.fn();

vi.mock('../httpClient.js', () => ({
	HttpClient: class MockHttpClient {
		sendMessage = send;
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

function sent(): CustomerMessage[] {
	return send.mock.calls.map(([message]) => message as CustomerMessage);
}

function hktanOf(message: CustomerMessage): HKTANSegment | undefined {
	return message.segments.find((s) => s.header.segId === HKTAN.Id) as HKTANSegment | undefined;
}

describe('fetching the TAN media', () => {
	let client: FinTSClient;
	let init: MockInstance;

	beforeEach(() => {
		send.mockReset();
		send.mockResolvedValue(new Message([]));

		const bankingInformation: BankingInformation = {
			systemId: 'SYSTEM',
			bankMessages: [],
			bpd: {
				version: 1,
				bankId: '12345678',
				bankName: 'Testbank',
				countryCode: 280,
				url: 'https://bank.example/fints',
				allowedTransactions: [{ transId: HKTAB.Id, tanRequired: false, versions: [5] }],
				supportedTanMethods: [
					{
						id: 923,
						name: 'pushTAN 2.0',
						version: 7,
						isDecoupled: true,
						activeTanMedia: [],
						tanMediaRequirement: 2,
					},
				],
				availableTanMethodIds: [923],
				supportedLanguages: [],
				maxTransactionsPerMessage: 1,
			} as unknown as BPD,
		};

		client = new FinTSClient(
			FinTSConfig.fromBankingInformation('PRODUCT', '1.0', bankingInformation, 'user', 'pin', 923),
		);

		init = vi
			.spyOn(InitDialogInteraction.prototype, 'handleClientResponse')
			.mockReturnValue(answer());
		vi.spyOn(TanMediaInteraction.prototype, 'handleClientResponse').mockImplementation(function (
			this: TanMediaInteraction,
		) {
			const response = answer() as ClientResponse & { tanMediaList: string[] };
			const hitab = { mediaList: [{ name: 'Alle Geräte' }] };
			// biome-ignore lint/suspicious/noExplicitAny: the segment lookup is all handleResponse reads
			this.handleResponse({ findSegment: () => hitab } as any, response);
			return response;
		});
	});

	it('opens a dialog for HKTAB that names no medium, then reads the list', async () => {
		const response = await client.getTanMedia();

		expect(response.tanMediaList).toEqual(['Alle Geräte']);
		const [open, list] = sent();
		expect(hktanOf(open)?.segId).toBe(HKTAB.Id);
		expect(hktanOf(open)?.tanMedia).toBeUndefined();
		expect(list.segments.some((s) => s.header.segId === HKTAB.Id)).toBe(true);
		// HKTAB once: the dialog init does not queue a second one.
		expect(sent().filter((m) => m.segments.some((s) => s.header.segId === HKTAB.Id))).toHaveLength(
			1,
		);
	});

	it('keeps the names on the TAN method, so one of them can be selected', async () => {
		await client.getTanMedia();

		expect(client.config.selectedTanMethod?.activeTanMedia).toEqual(['Alle Geräte']);
		client.selectTanMedia('Alle Geräte');
		expect(client.config.tanMediaName).toBe('Alle Geräte');
	});

	it('names the selected medium in the dialog after it', async () => {
		await client.getTanMedia();
		client.selectTanMedia('Alle Geräte');
		send.mockClear();

		await client.synchronize();

		const hktan = hktanOf(sent()[0]);
		expect(hktan?.segId).toBe('HKIDN');
		expect(hktan?.tanMedia).toBe('Alle Geräte');
	});

	it('answers with the refusal and no names when the bank will not open the dialog', async () => {
		init.mockReturnValue(answer({ success: false, bankAnswers: [{ code: 9955, text: 'no' }] }));

		const response = await client.getTanMedia();

		expect(response.success).toBe(false);
		expect(response.tanMediaList).toEqual([]);
	});

	it('needs a TAN method', async () => {
		const bare = new FinTSClient(
			FinTSConfig.forFirstTimeUse('PRODUCT', '1.0', 'https://bank.example', '12345678', 'u', 'p'),
		);

		await expect(bare.getTanMedia()).rejects.toThrow('TAN method');
	});
});
