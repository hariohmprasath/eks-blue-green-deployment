import * as cdk from '@aws-cdk/core';
import { BlueGreenDeployConstruct } from './index';

const app = new cdk.App();
const env = {
  region: process.env.CDK_DEFAULT_REGION,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

const stack = new cdk.Stack(app, 'blue-green-stack', { env });

new BlueGreenDeployConstruct(stack, 'BlueGreenDeploy', {
  serviceName: 'weather', // K8s service name goes here
});
