package com.springboot.demo.weather;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableAutoConfiguration
public class RdsConfig {

	private static final Logger LOG = LoggerFactory.getLogger(RdsConfig.class);

	@Bean
	@ConfigurationProperties(prefix = "spring.datasource")
	public DataSource dataSource() {
		String hostName = System.getenv("RDS_HOSTNAME");
		String userName = System.getenv("RDS_USERNAME");
		String password = System.getenv("RDS_PASSWORD");
		LOG.info("Database details {} - {}", hostName, userName);

		// Connect to RDS using the environment variables
		return DataSourceBuilder.create()
				.driverClassName("com.mysql.cj.jdbc.Driver")
				.url("jdbc:mysql://" + hostName + ":3306/weatheruserdatabase?createDatabaseIfNotExist=true&serverTimezone=UTC")
				.username(userName)
				.password(password)
				.build();
	}
}
