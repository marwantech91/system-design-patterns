import { SagaOrchestrator, createSaga, type SagaResult } from '../index';

interface OrderContext extends Record<string, unknown> {
  orderId: string;
  paymentId?: string;
  inventoryReserved?: boolean;
  shipmentId?: string;
  log: string[];
}

function makeContext(): OrderContext {
  return { orderId: 'order-1', log: [] };
}

describe('Saga Orchestrator Pattern', () => {
  describe('createSaga factory', () => {
    it('should return a SagaOrchestrator instance', () => {
      const saga = createSaga('test');
      expect(saga).toBeInstanceOf(SagaOrchestrator);
    });
  });

  describe('successful execution', () => {
    it('should run all steps in order and return success', async () => {
      const saga = createSaga<OrderContext>('PlaceOrder')
        .step(
          'ProcessPayment',
          async (ctx) => { ctx.paymentId = 'pay-1'; ctx.log.push('payment'); },
          async (ctx) => { ctx.log.push('refund'); },
        )
        .step(
          'ReserveInventory',
          async (ctx) => { ctx.inventoryReserved = true; ctx.log.push('reserve'); },
          async (ctx) => { ctx.log.push('unreserve'); },
        )
        .step(
          'ArrangeShipment',
          async (ctx) => { ctx.shipmentId = 'ship-1'; ctx.log.push('ship'); },
          async (ctx) => { ctx.log.push('cancel-ship'); },
        );

      const result = await saga.execute(makeContext());

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.context.paymentId).toBe('pay-1');
      expect(result.context.inventoryReserved).toBe(true);
      expect(result.context.shipmentId).toBe('ship-1');
      expect(result.context.log).toEqual(['payment', 'reserve', 'ship']);
      expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should work with a single step', async () => {
      const saga = createSaga<OrderContext>('SingleStep')
        .step(
          'OnlyStep',
          async (ctx) => { ctx.log.push('done'); },
          async (ctx) => { ctx.log.push('undo'); },
        );

      const result = await saga.execute(makeContext());
      expect(result.success).toBe(true);
      expect(result.context.log).toEqual(['done']);
    });
  });

  describe('failure and compensation', () => {
    it('should compensate completed steps in reverse order when a step fails', async () => {
      const saga = createSaga<OrderContext>('PlaceOrder')
        .step(
          'ProcessPayment',
          async (ctx) => { ctx.log.push('payment'); },
          async (ctx) => { ctx.log.push('comp:payment'); },
        )
        .step(
          'ReserveInventory',
          async (ctx) => { ctx.log.push('reserve'); },
          async (ctx) => { ctx.log.push('comp:reserve'); },
        )
        .step(
          'ArrangeShipment',
          async () => { throw new Error('Shipment service down'); },
          async (ctx) => { ctx.log.push('comp:ship'); },
        );

      const result = await saga.execute(makeContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ArrangeShipment');
      expect(result.error).toContain('Shipment service down');

      // Compensation happens in reverse: reserve first, then payment
      expect(result.context.log).toEqual([
        'payment', 'reserve', 'comp:reserve', 'comp:payment',
      ]);

      // Step statuses
      expect(result.steps[0].status).toBe('compensated');
      expect(result.steps[1].status).toBe('compensated');
      expect(result.steps[2].status).toBe('failed');
    });

    it('should not compensate if the first step fails', async () => {
      const saga = createSaga<OrderContext>('FailFirst')
        .step(
          'FirstStep',
          async () => { throw new Error('Boom'); },
          async (ctx) => { ctx.log.push('comp:first'); },
        )
        .step(
          'SecondStep',
          async (ctx) => { ctx.log.push('second'); },
          async (ctx) => { ctx.log.push('comp:second'); },
        );

      const result = await saga.execute(makeContext());

      expect(result.success).toBe(false);
      expect(result.context.log).toEqual([]); // no compensation needed
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps[1].status).toBe('pending');
    });

    it('should handle compensation failure gracefully (continue compensating)', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const saga = createSaga<OrderContext>('CompFail')
        .step(
          'Step1',
          async (ctx) => { ctx.log.push('s1'); },
          async () => { throw new Error('Comp1 failed'); },
        )
        .step(
          'Step2',
          async (ctx) => { ctx.log.push('s2'); },
          async (ctx) => { ctx.log.push('comp:s2'); },
        )
        .step(
          'Step3',
          async () => { throw new Error('s3 fails'); },
          async (ctx) => { ctx.log.push('comp:s3'); },
        );

      const result = await saga.execute(makeContext());

      expect(result.success).toBe(false);
      // Step2 compensated, Step1 compensation failed but was attempted
      expect(result.context.log).toContain('comp:s2');
      expect(result.steps[0].error).toContain('Compensation failed');

      consoleErrorSpy.mockRestore();
    });
  });

  describe('retries', () => {
    it('should retry a failing step up to the configured retry count', async () => {
      let attempts = 0;

      const saga = createSaga<OrderContext>('RetryTest')
        .step(
          'FlakyStep',
          async (ctx) => {
            attempts++;
            if (attempts < 3) throw new Error('Transient error');
            ctx.log.push('succeeded');
          },
          async (ctx) => { ctx.log.push('comp:flaky'); },
          { retries: 2 },
        );

      const result = await saga.execute(makeContext());

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
      expect(result.steps[0].attempts).toBe(3);
      expect(result.context.log).toEqual(['succeeded']);
    });

    it('should fail after exhausting all retries', async () => {
      const saga = createSaga<OrderContext>('RetryExhaust')
        .step(
          'AlwaysFails',
          async () => { throw new Error('Nope'); },
          async (ctx) => { ctx.log.push('comp'); },
          { retries: 2 },
        );

      const result = await saga.execute(makeContext());

      expect(result.success).toBe(false);
      expect(result.steps[0].attempts).toBe(3); // 1 initial + 2 retries
      expect(result.steps[0].status).toBe('failed');
    });
  });

  describe('timeout', () => {
    it('should fail a step that exceeds its timeout', async () => {
      const saga = createSaga<OrderContext>('TimeoutTest')
        .step(
          'SlowStep',
          async () => {
            await new Promise((r) => setTimeout(r, 500));
          },
          async (ctx) => { ctx.log.push('comp:slow'); },
          { timeout: 50 },
        );

      const result = await saga.execute(makeContext());

      expect(result.success).toBe(false);
      expect(result.steps[0].error).toContain('timed out');
    });
  });

  describe('hooks', () => {
    it('should call onStepComplete hook after each successful step', async () => {
      const hookCalls: string[] = [];

      const saga = createSaga<OrderContext>('HookTest')
        .step(
          'A',
          async (ctx) => { ctx.log.push('a'); },
          async () => {},
        )
        .step(
          'B',
          async (ctx) => { ctx.log.push('b'); },
          async () => {},
        )
        .hooks({
          onStepComplete: async (_ctx, stepName) => { hookCalls.push(`complete:${stepName}`); },
        });

      await saga.execute(makeContext());
      expect(hookCalls).toEqual(['complete:A', 'complete:B']);
    });

    it('should call onStepFailed and onCompensating hooks on failure', async () => {
      const hookCalls: string[] = [];

      const saga = createSaga<OrderContext>('HookFailTest')
        .step(
          'A',
          async (ctx) => { ctx.log.push('a'); },
          async () => {},
        )
        .step(
          'B',
          async () => { throw new Error('fail'); },
          async () => {},
        )
        .hooks({
          onStepFailed: async (_ctx, stepName) => { hookCalls.push(`failed:${stepName}`); },
          onCompensating: async (_ctx, stepName) => { hookCalls.push(`compensating:${stepName}`); },
        });

      await saga.execute(makeContext());
      expect(hookCalls).toContain('failed:B');
      expect(hookCalls).toContain('compensating:A');
    });
  });

  describe('step state tracking', () => {
    it('should record startedAt and completedAt timestamps for completed steps', async () => {
      const saga = createSaga<OrderContext>('Timestamps')
        .step(
          'Step1',
          async (ctx) => { ctx.log.push('s1'); },
          async () => {},
        );

      const result = await saga.execute(makeContext());

      expect(result.steps[0].startedAt).toBeDefined();
      expect(result.steps[0].completedAt).toBeDefined();
      expect(result.steps[0].completedAt!).toBeGreaterThanOrEqual(result.steps[0].startedAt!);
    });
  });
});
