/**
 * Saga Orchestrator Pattern
 *
 * Coordinates distributed transactions across multiple services.
 * Each step has a forward action and a compensating action (rollback).
 * If any step fails, all completed steps are compensated in reverse order.
 *
 * This is the orchestration variant — a central coordinator drives the saga.
 * Compare with choreography (event-driven) where each service reacts independently.
 */

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'compensated';

export interface SagaStep<TContext> {
  name: string;
  action: (context: TContext) => Promise<void>;
  compensate: (context: TContext) => Promise<void>;
  retries?: number;
  timeout?: number;
}

interface StepState {
  name: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  attempts: number;
}

export interface SagaResult<TContext> {
  success: boolean;
  context: TContext;
  steps: StepState[];
  error?: string;
  duration: number;
}

type SagaHook<TContext> = (context: TContext, stepName: string) => Promise<void> | void;

export class SagaOrchestrator<TContext extends Record<string, unknown>> {
  private steps: SagaStep<TContext>[] = [];
  private onStepComplete?: SagaHook<TContext>;
  private onStepFailed?: SagaHook<TContext>;
  private onCompensating?: SagaHook<TContext>;

  constructor(private name: string) {}

  step(
    name: string,
    action: (ctx: TContext) => Promise<void>,
    compensate: (ctx: TContext) => Promise<void>,
    options?: { retries?: number; timeout?: number }
  ): this {
    this.steps.push({ name, action, compensate, ...options });
    return this;
  }

  hooks(opts: {
    onStepComplete?: SagaHook<TContext>;
    onStepFailed?: SagaHook<TContext>;
    onCompensating?: SagaHook<TContext>;
  }): this {
    this.onStepComplete = opts.onStepComplete;
    this.onStepFailed = opts.onStepFailed;
    this.onCompensating = opts.onCompensating;
    return this;
  }

  async execute(context: TContext): Promise<SagaResult<TContext>> {
    const startTime = Date.now();
    const stepStates: StepState[] = this.steps.map((s) => ({
      name: s.name,
      status: 'pending' as StepStatus,
      attempts: 0,
    }));

    const completedSteps: number[] = [];

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const state = stepStates[i];
      state.status = 'running';
      state.startedAt = Date.now();

      const maxAttempts = (step.retries ?? 0) + 1;
      let succeeded = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        state.attempts = attempt + 1;

        try {
          if (step.timeout) {
            await Promise.race([
              step.action(context),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Step "${step.name}" timed out`)), step.timeout)
              ),
            ]);
          } else {
            await step.action(context);
          }

          state.status = 'completed';
          state.completedAt = Date.now();
          completedSteps.push(i);
          succeeded = true;
          await this.onStepComplete?.(context, step.name);
          break;
        } catch (error) {
          state.error = (error as Error).message;

          if (attempt === maxAttempts - 1) {
            state.status = 'failed';
            await this.onStepFailed?.(context, step.name);
          }
        }
      }

      if (!succeeded) {
        // Compensate all completed steps in reverse
        await this.compensate(context, completedSteps, stepStates);

        return {
          success: false,
          context,
          steps: stepStates,
          error: `Saga "${this.name}" failed at step "${step.name}": ${state.error}`,
          duration: Date.now() - startTime,
        };
      }
    }

    return {
      success: true,
      context,
      steps: stepStates,
      duration: Date.now() - startTime,
    };
  }

  private async compensate(
    context: TContext,
    completedSteps: number[],
    stepStates: StepState[]
  ): Promise<void> {
    // Reverse order compensation
    for (let i = completedSteps.length - 1; i >= 0; i--) {
      const stepIndex = completedSteps[i];
      const step = this.steps[stepIndex];
      const state = stepStates[stepIndex];

      try {
        await this.onCompensating?.(context, step.name);
        await step.compensate(context);
        state.status = 'compensated';
      } catch (error) {
        // Log but continue compensating other steps
        console.error(`Compensation failed for step "${step.name}":`, error);
        state.error = `Compensation failed: ${(error as Error).message}`;
      }
    }
  }
}

// === Factory ===

export function createSaga<TContext extends Record<string, unknown>>(
  name: string
): SagaOrchestrator<TContext> {
  return new SagaOrchestrator<TContext>(name);
}
