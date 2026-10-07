import { describe, expect, it } from 'vitest';
import { CustomerOrderInteraction } from '../interactions/customerInteraction.js';
import { Message } from '../message.js';
import { decode } from '../segment.js';
import { HKSAL } from '../segments/HKSAL.js';
import { registerSegments } from '../segments/registry.js';

registerSegments();

describe('a refusal next to a request for a TAN', () => {
	it('is a refusal', () => {
		const response = new Message([
			decode("HIRMG:2:2+9050::Die Nachricht enthaelt Fehler'"),
			decode(
				"HIRMS:3:2:3+9230::Zahlungsauftrag mangels Einreicherlimit abgelehnt+0030::Auftrag empfangen'",
			),
			decode("HITAN:4:7:3+4++REF+Bitte bestaetigen'"),
		]);

		const result = new (class extends CustomerOrderInteraction {
			createSegments() {
				return [];
			}
			handleResponse() {}
		})(HKSAL.Id, 'HISAL').handleClientResponse(response);

		expect(result.success).toBe(false);
		expect(result.requiresTan).toBe(false);
		expect(result.bankAnswers.map((a) => a.code)).toContain(9230);
	});
});
