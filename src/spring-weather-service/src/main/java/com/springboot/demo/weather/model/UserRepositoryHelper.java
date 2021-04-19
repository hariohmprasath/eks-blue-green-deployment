package com.springboot.demo.weather.model;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
public class UserRepositoryHelper {

	private static final Logger LOG = LoggerFactory.getLogger(UserRepositoryHelper.class);

	@Autowired
	private UserRepository userRepository;

	@Transactional(readOnly = true)
	public User findOneByApiKey(String apiKey) {
		try {
			return userRepository.findOneByApiKey(apiKey);
		}
		catch (Exception e) {
			LOG.warn("Entity not found {}", apiKey, e);
		}
		return null;
	}

	@Transactional(readOnly = true)
	public User findOneByUsername(String username){
		try {
			return userRepository.findOneByUsername(username);
		}
		catch (Exception e) {
			LOG.warn("Entity not found {}", username, e);
		}
		return null;
	}

	@Transactional
	public void deleteByApiKey(String apiKey){
		userRepository.deleteByApiKey(apiKey);
	}

	@Transactional
	public User save(User user){
		return userRepository.save(user);
	}
}
