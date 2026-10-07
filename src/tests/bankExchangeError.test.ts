import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankExchangeError } from '../bankExchangeError.js';
import { binaryToBase64 } from '../bytes.js';
import { HttpClient } from '../httpClient.js';
import { CustomerMessage } from '../message.js';
import { HKEND, type HKENDSegment } from '../segments/HKEND.js';
import { registerSegments } from '../segments/registry.js';

registerSegments();

const answer = (body: string, status = 200) =>
	vi.fn().mockResolvedValue(new Response(body, { status }));

async function thrownBy(fetchMock: ReturnType<typeof vi.fn>) {
	vi.stubGlobal('fetch', fetchMock);
	vi.spyOn(console, 'error').mockImplementation(() => {});

	const message = new CustomerMessage('DIALOG', 1);
	message.addSegment({
		header: { segId: HKEND.Id, segNr: 0, version: HKEND.Version },
		dialogId: 'DIALOG',
	} as HKENDSegment);

	return await new HttpClient('https://bank.example/fints')
		.sendMessage(message)
		.catch((error) => error);
}

describe('an exchange with the bank that did not complete', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('is told apart when the bank cannot be reached', async () => {
		const cause = new TypeError('fetch failed');
		const error = await thrownBy(vi.fn().mockRejectedValue(cause));

		expect(error).toBeInstanceOf(BankExchangeError);
		expect(error.stage).toBe('connection');
		expect(error.cause).toBe(cause);
	});

	it('is told apart when something other than the bank answers', async () => {
		const error = await thrownBy(answer('Bad Gateway', 502));

		expect(error).toBeInstanceOf(BankExchangeError);
		expect(error.stage).toBe('connection');
		expect(error.message).toContain('502');
	});

	it('is told apart when the answer cannot be read', async () => {
		const error = await thrownBy(answer(binaryToBase64("HNHBK:1:3+not+a+message'")));

		expect(error).toBeInstanceOf(BankExchangeError);
		expect(error.stage).toBe('answer');
	});
});
