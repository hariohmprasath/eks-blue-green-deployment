package com.springboot.demo.weather.web;

import java.util.Random;
import java.util.UUID;

import com.springboot.demo.weather.model.User;
import com.springboot.demo.weather.model.UserRepositoryHelper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RequestMapping("/user")
@RestController
@CrossOrigin
@ComponentScan
public class UserResource {

	private static final Logger LOG = LoggerFactory.getLogger(UserResource.class);

	@Autowired
	private UserRepositoryHelper userRepositoryHelper;

	@Value("${version}")
	private String version;

	/**
	 * Saves user details in RDS and generates the API key
	 * @param user user details POJO
	 * @return API key
	 */
	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	public ResponseEntity<String> createUser(@RequestBody User user) {
		final String userName = user.getUsername();
		ResponseEntity<String> responseEntity;
		String error;

		// Validate terms and condition
		if (!user.isTermsAndConditions()) {
			error = "Terms and conditions needs to be accepted before proceeding with the registration: " + userName;
			LOG.error(error);
			return new ResponseEntity<>(error, HttpStatus.BAD_REQUEST);
		}

		// Fetch Subsegment
		final User userDetails = userRepositoryHelper.findOneByUsername(userName);
		if (userDetails != null) {
			error = String.format("User already exists %s", userDetails.getUsername());
			responseEntity = new ResponseEntity<>(error, HttpStatus.BAD_REQUEST);
		}
		else {
			final String apiKey = UUID.randomUUID().toString();
			user.setApiKey(apiKey);
			final User newUser = userRepositoryHelper.save(user);
			LOG.info("New User created {}", newUser);
			responseEntity = new ResponseEntity<>(apiKey, HttpStatus.OK);
		}

		return responseEntity;
	}

	@GetMapping("/version")
	public ResponseEntity<String> getVersion(){
		return new ResponseEntity<>(version, HttpStatus.OK);
	}

	/**
	 * Fetch user details
	 * @param userName username
	 * @return user details POJO
	 */
	@GetMapping(value = "/details")
	public ResponseEntity<User> getUserDetails(@RequestParam("username") String userName) {
		final User userDetails = userRepositoryHelper.findOneByUsername(userName);
		if (userDetails == null) {
			String error = String.format("User doesnt exists %s", userName);
			LOG.error(error);
			return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
		}
		else
			return new ResponseEntity<>(userDetails, HttpStatus.OK);
	}

	/**
	 * Generates a number between the LOW_NUMBER and HIGH_NUMBER set in the environment variable
	 * @param apiKey API key for the user
	 * @param location location in the form of longitude, latitude
	 * @return weather details
	 */
	@GetMapping(value = "/weather", produces = MediaType.APPLICATION_JSON_VALUE)
	public ResponseEntity<String> getWeatherData(
			@RequestParam("apiKey") String apiKey,
			@RequestParam("location") String location) {

		// Check whether the API key is valid by looking into the database
		User user = userRepositoryHelper.findOneByApiKey(apiKey);
		String error;
		if (user == null) {
			error = "Invalid API key " + apiKey;
			LOG.error(error);
			return new ResponseEntity<>(error, HttpStatus.BAD_REQUEST);
		}

		// Fetch weather data
		try {
			if (location.equalsIgnoreCase(System.getenv("DEFAULT_CITY")))
				return new ResponseEntity<>(System.getenv("DEFAULT_CITY_TEMP"), HttpStatus.OK);
			else {
				final Random r = new Random();
				int low = Integer.parseInt(System.getenv("LOW_NUMBER"));
				int high = Integer.parseInt(System.getenv("HIGH_NUMBER"));
				int result = r.nextInt(high - low) + low;

				return new ResponseEntity<>(String.valueOf(result), HttpStatus.OK);
			}
		}
		catch (NumberFormatException e) {
			error = "Error while fetching weather data " + e.getMessage();
			LOG.error(error, e.getMessage(), e);
			return new ResponseEntity<>(error, HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}


	/**
	 * Delete user details from database
	 * @param apiKey API key
	 */
	@DeleteMapping
	public void deleteUser(@RequestParam("apiKey") String apiKey) {
		userRepositoryHelper.deleteByApiKey(apiKey);
	}
}
