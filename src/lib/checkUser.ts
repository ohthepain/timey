import prisma from '~/config/db';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { redirect } from '@tanstack/react-router';
import { users } from '@clerk/clerk-sdk-node';

export const checkUser = async (req: any) => {
  console.log('checkUser');
  const { userId } = await getAuth(req);
  if (!userId) {
    console.log('checkUser: User is not authenticated');
    throw new Error('User is not authenticated');
  }
  if (!userId) {
    throw redirect({
      to: '/sign-in/$',
    });
  }

  // Check if the user already exists in the database
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (existingUser) {
    console.log('checkUser: User already exists in the database. Good good good.');
    return userId;
  }

  console.log('checkUser: User does not exist in the database, creating a new user');

  // Use the Backend SDK's `getUser()` method to get the Backend User object
  const user = await users.getUser(userId);
  console.log('User from Clerk:', user);
  const emailId = user.primaryEmailAddressId;
  console.log('Email ID:', emailId);
  const email = user.emailAddresses.find((email) => email.id === emailId);
  console.log('Email:', email);

  // Create the user in the database
  await prisma.user.create({
    data: {
      id: userId,
      email: email?.emailAddress || '',
      firstName: `${user.firstName || ''}`.trim(),
      lastName: `${user.lastName || ''}`.trim(),
    },
  });

  return userId;
};
