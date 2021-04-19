const { AwsCdkConstructLibrary } = require('projen');

const project = new AwsCdkConstructLibrary({
  author: 'Hari Ohm Prasath',
  authorAddress: 'hariohmprasath@gmail.com',
  cdkVersion: '1.73.0',
  defaultReleaseBranch: 'main',
  jsiiFqn: 'projen.AwsCdkConstructLibrary',
  name: 'eks-blue-green-deployment',
  repositoryUrl: 'git@ssh.gitlab.aws.dev:am3-app-modernization-gsp/eks/eks-blue-green-deployment.git',
  cdkDependencies: [
    '@aws-cdk/core',
    '@aws-cdk/aws-ec2',
    '@aws-cdk/aws-ecs',
    '@aws-cdk/aws-codebuild',
    '@aws-cdk/aws-codecommit',
    '@aws-cdk/aws-ecr',
    '@aws-cdk/aws-eks',
    '@aws-cdk/aws-events-targets',
    '@aws-cdk/aws-iam',
    '@aws-cdk/aws-codepipeline',
    '@aws-cdk/aws-codepipeline-actions',
    '@aws-cdk/aws-rds',
  ],
  gitignore: [
    'cdk.out',
    '.DS_Store',
    'yarn.lock',
    '.idea',
    '**/.classpath',
    '**.factorypath',
    '**/.settings/*',
    '**/target/*',
    '**/.project',
    '**/.idea/*',
  ],
});

project.synth();
