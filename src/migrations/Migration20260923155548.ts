import { Migration } from '@mikro-orm/migrations';

/**
 * Alinea las dos tablas pivote de Restricted Schedule con lo que MikroORM
 * genera a partir de las entidades. Se escribieron a mano en
 * Migration20260923120000 / 140000 con un nombre de constraint más corto y con
 * dos índices sobre `plan_id` que las entidades no declaran; esa diferencia
 * reaparecía en cada `migration:create`.
 *
 * Los índices se van en vez de declararse: las pivote tienen como mucho
 * schedules × planes de una empresa, y la búsqueda inversa (qué horarios
 * exigen este plan, ADR 0005 → archivar un plan) no justifica un índice
 * que el metadata no conoce.
 */
export class Migration20260923155548 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "schedule_programmed_allowed_plans" drop constraint "schedule_programmed_allowed_plans_sp_id_foreign";`
    );

    this.addSql(
      `alter table "schedule_programmed_allowed_plans" add constraint "schedule_programmed_allowed_plans_schedule_progr_5f427_foreign" foreign key ("schedule_programmed_id") references "schedule_programmed" ("id") on update cascade on delete cascade;`
    );

    this.addSql(
      `drop index "schedule_programmed_allowed_plans_plan_id_index";`
    );

    this.addSql(`drop index "schedule_allowed_plans_plan_id_index";`);
  }

  override async down(): Promise<void> {
    this.addSql(
      `create index "schedule_allowed_plans_plan_id_index" on "schedule_allowed_plans" ("plan_id");`
    );

    this.addSql(
      `create index "schedule_programmed_allowed_plans_plan_id_index" on "schedule_programmed_allowed_plans" ("plan_id");`
    );

    this.addSql(
      `alter table "schedule_programmed_allowed_plans" drop constraint "schedule_programmed_allowed_plans_schedule_progr_5f427_foreign";`
    );

    this.addSql(
      `alter table "schedule_programmed_allowed_plans" add constraint "schedule_programmed_allowed_plans_sp_id_foreign" foreign key ("schedule_programmed_id") references "schedule_programmed" ("id") on update cascade on delete cascade;`
    );
  }
}
