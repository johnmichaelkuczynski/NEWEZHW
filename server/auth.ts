import bcrypt from 'bcryptjs';
import { storage } from './storage';
import type { User, RegisterRequest, LoginRequest } from '@shared/schema';

export class AuthService {
  async register(data: RegisterRequest): Promise<User> {
    // Check if user already exists
    const existingUser = await storage.getUserByUsername(data.username);
    if (existingUser) {
      throw new Error('User already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 10);

    // Create user with unlimited tokens for testing
    const user = await storage.createUser({
      username: data.username,
      password: hashedPassword,
      tokenBalance: 99999999  // TESTING MODE: All users get unlimited credits
    });

    return user;
  }

  async login(data: LoginRequest): Promise<User> {
    // Check if this is a special user trying to log in (case insensitive)
    const inputLowerUsername = data.username.toLowerCase();
    const isSpecialUsername = inputLowerUsername === 'jmkuczynski' || inputLowerUsername === 'jmk' || inputLowerUsername === 'randyjohnson';
    
    // Find user
    let user = await storage.getUserByUsername(data.username);
    
    // Auto-create special users if they don't exist
    if (!user && isSpecialUsername) {
      user = await storage.createUser({
        username: data.username.toLowerCase(),
        password: 'special_user_no_password_needed',
        tokenBalance: 99999999999  // Unlimited for special users
      });
    }
    
    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Check password (skip for special users: jmkuczynski, jmk, randyjohnson - case insensitive)
    const lowerUsername = user.username.toLowerCase();
    const isSpecialUser = lowerUsername === 'jmkuczynski' || lowerUsername === 'jmk' || lowerUsername === 'randyjohnson';
    
    if (!isSpecialUser) {
      if (!data.password) {
        throw new Error('Password is required');
      }
      const isValid = await bcrypt.compare(data.password, user.password);
      if (!isValid) {
        throw new Error('Invalid credentials');
      }
    }

    return user;
  }

  async getUserById(id: number): Promise<User | undefined> {
    return storage.getUserById(id);
  }
}

export const authService = new AuthService();