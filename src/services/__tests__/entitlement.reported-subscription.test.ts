import { SubscriptionStatus } from '../../entities/Subscription';
import { selectReportedSubscription } from '../entitlement.service';

/** Suscripción vigente con los créditos y el fin de periodo dados. */
function livingUntil(
  id: string,
  daysAhead: number,
  creditsTotal: number | null = null
): any {
  return {
    id,
    plan: { id: `plan-${id}` },
    status: SubscriptionStatus.ACTIVE,
    currentPeriodEnd: new Date(Date.now() + daysAhead * 86400000),
    creditsTotal,
  };
}

/**
 * Tests de la resolución determinista de los escalares deprecados — issue #20
 * (ADR 0006): gana la vigente **ilimitada** y, en empate o si ninguna lo es, la
 * de `currentPeriodEnd` más lejano.
 *
 * Lo que se fija aquí es la **estabilidad**: comprar un Session Pack no puede
 * cambiar lo que muestra una app antigua que solo lee el singular.
 */
describe('selectReportedSubscription', () => {
  it('should report the only subscription a member holds', () => {
    const only = livingUntil('sub-1', 30);

    expect(selectReportedSubscription([only])).toBe(only);
  });

  it('should report null for an empty Entitlement', () => {
    expect(selectReportedSubscription([])).toBeNull();
  });

  it('should let the unlimited subscription win over a Session Pack that lasts longer', () => {
    const unlimited = livingUntil('sub-premium', 10, null);
    const pack = livingUntil('sub-pack', 400, 10);

    expect(selectReportedSubscription([pack, unlimited])).toBe(unlimited);
  });

  it('should not change what it reports when a Session Pack joins an unlimited subscription', () => {
    const unlimited = livingUntil('sub-premium', 30);
    const before = selectReportedSubscription([unlimited]);

    const after = selectReportedSubscription([
      unlimited,
      livingUntil('sub-pack', 400, 10),
    ]);

    expect(after).toBe(before);
  });

  it('should fall back to the furthest period end when none is unlimited', () => {
    const near = livingUntil('sub-near', 5, 10);
    const far = livingUntil('sub-far', 50, 3);

    expect(selectReportedSubscription([near, far])).toBe(far);
  });

  it('should break a tie between two unlimited subscriptions by the furthest period end', () => {
    const near = livingUntil('sub-near', 5);
    const far = livingUntil('sub-far', 50);

    expect(selectReportedSubscription([near, far])).toBe(far);
  });

  it('should resolve the same whatever order the Entitlement arrives in', () => {
    const a = livingUntil('sub-a', 30);
    const b = livingUntil('sub-b', 30);

    expect(selectReportedSubscription([a, b])).toBe(
      selectReportedSubscription([b, a])
    );
  });

  it('should rank a subscription without a period end below one that has it', () => {
    const dated = livingUntil('sub-dated', 1);
    const undated = {
      ...livingUntil('sub-undated', 0),
      currentPeriodEnd: null,
    };

    expect(selectReportedSubscription([undated, dated])).toBe(dated);
  });
});
