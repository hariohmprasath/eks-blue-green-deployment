import * as cdk from '@aws-cdk/core';
import { BlueGreenDeployConstruct } from '../src';
import '@aws-cdk/assert/jest';

test('create app', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app);
  new BlueGreenDeployConstruct(stack, 'EksCluster', {
    serviceName: 'weather-service',
  });
  expect(stack).toHaveResource('AWS::Lambda::Function');
  expect(stack).toHaveResource('AWS::CodeCommit::Repository');
  expect(stack).toHaveResource('AWS::Events::Rule');
  expect(stack).toHaveResource('AWS::EC2::VPCEndpoint');
  expect(stack).toHaveResource('AWS::SecretsManager::Secret');
  expect(stack).toHaveResource('Custom::AWSCDK-EKS-KubernetesResource');
  expect(stack).toHaveResource('Custom::AWSCDKOpenIdConnectProvider');
  expect(stack).toHaveResource('AWS::IAM::Policy');
  expect(stack).toHaveResource('AWS::IAM::Role');
  expect(stack).toHaveResource('Custom::AWSCDK-EKS-HelmChart');
  expect(stack).toHaveResource('AWS::EKS::Nodegroup');
  expect(stack).toHaveResource('AWS::EC2::SecurityGroup');
  expect(stack).toHaveResource('AWS::SecretsManager::Secret');
  expect(stack).toHaveResource('AWS::RDS::DBCluster');
  expect(stack).toHaveResource('AWS::CodeBuild::Project');
  expect(stack).toHaveResource('AWS::CodePipeline::Pipeline');
});
