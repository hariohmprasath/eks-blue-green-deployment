FROM public.ecr.aws/y7p5z1g8/amazoncorretto:11.0.7
ARG JAR_FILE=target/*.jar
COPY ${JAR_FILE} app.jar
ENTRYPOINT ["java","-jar","/app.jar"]
EXPOSE 8080
