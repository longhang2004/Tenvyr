package io.tenvyr.review;

import io.tenvyr.platform.Db;
import io.tenvyr.platform.Migrator;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

import javax.sql.DataSource;

/**
 * Migration strategy orchestrating base TypeORM migrations and Flyway review-schema migrations.
 * Validates configuration before migrations, runs base Migrator first, Flyway second,
 * and ensures fixed catalog pipeline exists within caller-owned transaction.
 */
@Configuration
public class ReviewMigrationConfiguration {

    private final Environment environment;

    public ReviewMigrationConfiguration(Environment environment) {
        this.environment = environment;
    }

    @Bean
    public FlywayMigrationStrategy flywayMigrationStrategy() {
        return flyway -> {
            // 1. Validate review HTTP/no-Kafka configuration before running any migrations
            EngineConfiguration.validateReviewEnvironment(environment);

            DataSource ds = flyway.getConfiguration().getDataSource();
            Db db = Db.fromDataSource(ds);

            // 2. Retained base migrations run first
            Migrator.migrate(db);

            // 3. Flyway review domain migrations run second
            flyway.migrate();

            // 4. Ensure pipeline catalog exists within a caller-owned transaction
            Db.fromDataSource(ds).transaction(tx -> PipelineCatalog.ensure(tx.connection()));
        };
    }
}
