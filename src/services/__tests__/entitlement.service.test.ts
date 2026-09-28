import {
  Subscription,
  SubscriptionAccessState,
  SubscriptionStatus,
} from '../../entities/Subscription';
import {
  aggregateSubscriptionState,
  EntitlementService,
  findAdmittingSubscription,
} from '../entitlement.service';

/**
 * Tests del seam EntitlementService — issue #16.
 *
 * El servicio es el **único** sitio donde vive la pregunta "¿qué suscripciones
 * de este miembro están vigentes ahora mismo en esta empresa?". Este prefactor
 * no cambia el comportamiento: sigue respondiendo con una sola suscripción.
 * Lo que se fija aquí son las dos propiedades que obligaron a duplicar la
 * consulta: aceptar un `EntityManager` transaccional y tolerar que no haya
 * empresa en contexto.
 */
describe('EntitlementService.findLiveSubscription', () => {
  let service: EntitlementService;
  let mockEm: any;
  let found: any;

  beforeEach(() => {
    found = new Subscription();
    Object.assign(found, { id: 'sub-1' });

    mockEm = { findOne: jest.fn(async () => found) };
    service = new EntitlementService(mockEm as any);
  });

  it('should return the subscription of the member in the company when one is live', async () => {
    const result = await service.findLiveSubscription('user-1', 'comp-1');

    expect(result).toBe(found);
  });

  it('should ask for ACTIVE/TRIALING rows whose paid period is in progress', async () => {
    await service.findLiveSubscription('user-1', 'comp-1');

    const [entity, where] = mockEm.findOne.mock.calls[0];
    expect({ entity, ...where }).toEqual({
      entity: Subscription,
      user: 'user-1',
      company: 'comp-1',
      status: {
        $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
      },
      currentPeriodStart: { $lte: expect.any(Date) },
      currentPeriodEnd: { $gte: expect.any(Date) },
    });
  });

  it('should bypass the companyContext filter when a company is given', async () => {
    await service.findLiveSubscription('user-1', 'comp-1');

    const [, , options] = mockEm.findOne.mock.calls[0];
    expect(options.filters).toBe(false);
  });

  it('should let the companyContext filter act when no company is in scope', async () => {
    await service.findLiveSubscription('user-1', undefined);

    const [, where, options] = mockEm.findOne.mock.calls[0];
    expect('company' in where).toBe(false);
    expect(options?.filters).toBeUndefined();
  });

  it('should query through the EntityManager the caller supplies (a transaction)', async () => {
    const tem: any = { findOne: jest.fn(async () => found) };

    await service.findLiveSubscription('user-1', 'comp-1', { em: tem });

    expect(tem.findOne).toHaveBeenCalledTimes(1);
  });

  it('should not use its own EntityManager when the caller supplies one', async () => {
    const tem: any = { findOne: jest.fn(async () => found) };

    await service.findLiveSubscription('user-1', 'comp-1', { em: tem });

    expect(mockEm.findOne).not.toHaveBeenCalled();
  });

  it('should populate nothing when the caller asks for nothing', async () => {
    await service.findLiveSubscription('user-1', 'comp-1');

    expect(mockEm.findOne.mock.calls[0][2].populate).toBeUndefined();
  });

  it('should populate what the caller asks for', async () => {
    await service.findLiveSubscription('user-1', 'comp-1', {
      populate: ['plan'],
    });

    expect(mockEm.findOne.mock.calls[0][2].populate).toEqual(['plan']);
  });

  it('should return null when no subscription is live', async () => {
    found = null;

    const result = await service.findLiveSubscription('user-1', 'comp-1');

    expect(result).toBeNull();
  });
});

/**
 * Tests de la consulta plural — issue #19.
 *
 * La unión de permisos necesita **todas** las suscripciones vigentes, no una.
 * La consulta plural comparte predicado y semántica de tenencia con la
 * singular: lo que se fija aquí es que no divergen.
 */
describe('EntitlementService.findLiveSubscriptions', () => {
  let service: EntitlementService;
  let mockEm: any;
  let found: any[];

  beforeEach(() => {
    found = [Object.assign(new Subscription(), { id: 'sub-1' })];
    mockEm = { find: jest.fn(async () => found) };
    service = new EntitlementService(mockEm as any);
  });

  it('should return every live subscription of the member in the company', async () => {
    found = [
      Object.assign(new Subscription(), { id: 'sub-1' }),
      Object.assign(new Subscription(), { id: 'sub-2' }),
    ];

    const result = await service.findLiveSubscriptions('user-1', 'comp-1');

    expect(result.map(s => s.id)).toEqual(['sub-1', 'sub-2']);
  });

  it('should ask for the same predicate as the singular query', async () => {
    await service.findLiveSubscriptions('user-1', 'comp-1');

    const [entity, where] = mockEm.find.mock.calls[0];
    expect({ entity, ...where }).toEqual({
      entity: Subscription,
      user: 'user-1',
      company: 'comp-1',
      status: {
        $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
      },
      currentPeriodStart: { $lte: expect.any(Date) },
      currentPeriodEnd: { $gte: expect.any(Date) },
    });
  });

  it('should bypass the companyContext filter when a company is given', async () => {
    await service.findLiveSubscriptions('user-1', 'comp-1');

    expect(mockEm.find.mock.calls[0][2].filters).toBe(false);
  });

  it('should let the companyContext filter act when no company is in scope', async () => {
    await service.findLiveSubscriptions('user-1', undefined);

    const [, where, options] = mockEm.find.mock.calls[0];
    expect('company' in where).toBe(false);
    expect(options?.filters).toBeUndefined();
  });

  it('should query through the EntityManager the caller supplies (a transaction)', async () => {
    const tem: any = { find: jest.fn(async () => found) };

    await service.findLiveSubscriptions('user-1', 'comp-1', { em: tem });

    expect(tem.find).toHaveBeenCalledTimes(1);
    expect(mockEm.find).not.toHaveBeenCalled();
  });

  it('should populate what the caller asks for', async () => {
    await service.findLiveSubscriptions('user-1', 'comp-1', {
      populate: ['plan'],
    });

    expect(mockEm.find.mock.calls[0][2].populate).toEqual(['plan']);
  });

  it('should return an empty Entitlement when nothing is live', async () => {
    found = [];

    const result = await service.findLiveSubscriptions('user-1', 'comp-1');

    expect(result).toEqual([]);
  });
});

/** Suscripción del Entitlement al plan dado, en el estado dado. */
function subscriptionTo(
  planId: string,
  status = SubscriptionStatus.ACTIVE
): any {
  return { id: `sub-${planId}`, plan: { id: planId }, status };
}

/**
 * Tests de las reglas de acceso escritas sobre el conjunto — issue #18.
 *
 * El gate de **Restricted Schedule** deja de mirar `hasActive` y pregunta si
 * *alguna suscripción concreta* del Entitlement admite el horario y está ella
 * misma en `ACTIVE`/`TRIALING` (ADR 0006, decisión 5).
 */
describe('findAdmittingSubscription', () => {
  const requiredPlans: any[] = [
    { id: 'plan-premium' },
    { id: 'plan-unlimited' },
  ];

  it('should return the subscription whose plan the schedule admits', () => {
    const admitted = subscriptionTo('plan-premium');

    expect(findAdmittingSubscription([admitted], requiredPlans)).toBe(admitted);
  });

  it('should find the admitted subscription among several the member holds', () => {
    const admitted = subscriptionTo('plan-unlimited');

    expect(
      findAdmittingSubscription(
        [subscriptionTo('plan-basic'), admitted],
        requiredPlans
      )
    ).toBe(admitted);
  });

  it('should return null when no subscription is to an admitted plan', () => {
    expect(
      findAdmittingSubscription([subscriptionTo('plan-basic')], requiredPlans)
    ).toBeNull();
  });

  it('should return null for an empty Entitlement', () => {
    expect(findAdmittingSubscription([], requiredPlans)).toBeNull();
  });

  it('should admit a TRIALING subscription to an admitted plan', () => {
    const trialing = subscriptionTo(
      'plan-premium',
      SubscriptionStatus.TRIALING
    );

    expect(findAdmittingSubscription([trialing], requiredPlans)).toBe(trialing);
  });

  it('should not let a PAST_DUE subscription open the door', () => {
    const pastDue = subscriptionTo('plan-premium', SubscriptionStatus.PAST_DUE);

    expect(findAdmittingSubscription([pastDue], requiredPlans)).toBeNull();
  });

  it('should keep a PAST_DUE subscription shut while another one keeps general access', () => {
    const entitlement = [
      subscriptionTo('plan-basic'),
      subscriptionTo('plan-premium', SubscriptionStatus.PAST_DUE),
    ];

    expect(findAdmittingSubscription(entitlement, requiredPlans)).toBeNull();
  });
});

/**
 * `subscriptionState` es uno solo y agregado sobre todo el Entitlement, con
 * precedencia `ACTIVE > SCHEDULED > EXPIRED > NONE` (ADR 0006, decisión 10).
 */
describe('aggregateSubscriptionState', () => {
  it('should read ACTIVE when the Entitlement is not empty', () => {
    expect(
      aggregateSubscriptionState(
        [subscriptionTo('plan-premium')],
        SubscriptionAccessState.NONE
      )
    ).toBe(SubscriptionAccessState.ACTIVE);
  });

  it('should read ACTIVE for a member live on one plan and expired on another', () => {
    expect(
      aggregateSubscriptionState(
        [subscriptionTo('plan-premium')],
        SubscriptionAccessState.EXPIRED
      )
    ).toBe(SubscriptionAccessState.ACTIVE);
  });

  it('should keep SCHEDULED when the Entitlement is empty', () => {
    expect(
      aggregateSubscriptionState([], SubscriptionAccessState.SCHEDULED)
    ).toBe(SubscriptionAccessState.SCHEDULED);
  });

  it('should keep NONE when the Entitlement is empty and nothing came before', () => {
    expect(aggregateSubscriptionState([], SubscriptionAccessState.NONE)).toBe(
      SubscriptionAccessState.NONE
    );
  });
});
