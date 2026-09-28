import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { EntitlementService } from '../entitlement.service';

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
